/**
 * The question this file answers: does a recorded meeting's TRANSCRIPT actually
 * come back summarized when the AI provider is a local CLI agent?
 *
 * It drives the real route — `runSkill(ENHANCE_SKILL_ID, …)`, the same function
 * the renderer's Enhance button reaches through the local backend — over a real
 * product-store SQLite with a real note, a real completed recording and real
 * transcript segments. Only the CLI binary is a stand-in: a script on disk, so
 * the test is free, offline and deterministic. Everything between the note rows
 * and the process boundary is production code, including the skill prompt, the
 * transcript assembly, the fallback ladder and the artifact write-back.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterAll, assert, describe, expect, it } from 'vitest';
import { ENHANCE_SKILL_ID } from '@prismical/ai-prompts';
import { applyProductMigrations } from '../../src/main/infra/product-db/migrations';
import * as schema from '../../src/main/infra/product-db/schema';
import {
  acceptSkillRun,
  runSkill,
  seedSystemSkills,
} from '../../src/main/domains/local-backend/skills';
import type { LocalAiPort } from '../../src/main/domains/local-backend/ai-port';
import type { LocalDb } from '../../src/main/domains/local-backend/wire';
import { makeBinaryResolver } from '../../src/main/domains/ai-provider/cli/binary-path';
import { makeInvocationResolver } from '../../src/main/domains/ai-provider/cli/invocation';
import { createCliLanguageModel } from '../../src/main/domains/ai-provider/cli/language-model';

const scratch = mkdtempSync(path.join(tmpdir(), 'prismical-skill-cli-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const NOW = '2026-09-07T10:00:00.000Z';

/** The lines a real recording would have produced, in the app's own segment shape. */
const TRANSCRIPT_LINES: ReadonlyArray<{ speaker: 'you' | 'them'; text: string }> = [
  { speaker: 'you', text: 'We need to decide on the launch date for the billing revamp.' },
  { speaker: 'them', text: "The migration script is ready but we haven't load-tested it." },
  { speaker: 'you', text: 'How long would a proper load test take?' },
  { speaker: 'them', text: 'Two days if we start tomorrow. Dana has staging booked though.' },
  { speaker: 'them', text: 'I can free up staging Thursday morning.' },
  { speaker: 'you', text: "Then let's target the 14th, contingent on the load test passing." },
  { speaker: 'them', text: "I'll own the load test and report back Friday afternoon." },
];

const makeDb = (): LocalDb => {
  const client = new Database(':memory:');
  applyProductMigrations(client);
  return drizzle(client, { schema }) as unknown as LocalDb;
};

const seedMeetingNote = async (db: LocalDb): Promise<{ noteId: string; recordingId: string }> => {
  const noteId = 'note_meeting_1';
  const recordingId = 'rec_meeting_1';
  await db.insert(schema.note).values({
    id: noteId,
    title: 'Billing revamp sync',
    createdAt: NOW,
    updatedAt: NOW,
    metadataUpdatedAt: NOW,
    contentMarkdown: '',
  });
  await db.insert(schema.recording).values({
    id: recordingId,
    title: 'Billing revamp sync',
    captureMode: 'mic',
    status: 'completed',
    noteId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(schema.transcriptSegment).values(
    TRANSCRIPT_LINES.map((line, index) => ({
      id: `seg_${String(index)}`,
      recordingId,
      source: 'mic' as const,
      speaker: line.speaker,
      text: line.text,
      startTimeMs: index * 5_000,
      endTimeMs: index * 5_000 + 4_000,
      segmentOrder: index,
      isFinal: true,
      createdAt: NOW,
      updatedAt: NOW,
    }))
  );
  return { noteId, recordingId };
};

/**
 * A stub agent CLI. It reads the whole prompt on stdin and writes the prompt to
 * `capture` so the test can assert the TRANSCRIPT really reached the model,
 * then prints the JSON object the ladder's structured-output rung asks for.
 */
const writeStubCli = (capture: string): string => {
  const dir = path.join(scratch, 'bin');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'claude');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      `cat > "${capture}"`,
      // A summary that quotes the transcript back, the way a real model would.
      `printf '%s' '{"markdown":"## Summary\\n\\n- Target launch: the 14th, contingent on the load test passing.\\n- Load test owned by Them, reporting Friday afternoon.","reasoning":null}'`,
    ].join('\n'),
    'utf8'
  );
  chmodSync(file, 0o755);
  return dir;
};

/** The AI port the local backend uses, wired to the real CLI language model. */
const makeCliAiPort = (binDir: string): LocalAiPort => {
  const resolver = makeBinaryResolver({
    processPath: binDir,
    staticDirs: [],
    readLoginShellPath: () => Promise.resolve([]),
  });
  const modelId = 'claude';
  return {
    resolve: () =>
      Promise.resolve({
        ok: true,
        value: {
          provider: 'cli',
          modelId,
          instanceId: 'inst_local_cli',
          model: createCliLanguageModel({
            modelId,
            invocation: makeInvocationResolver({ resolver, modelId, cliCommand: null }),
          }),
          // What AiProviderLive pins for this provider.
          toolSupport: 'none',
        },
      }),
    instances: () => Promise.resolve([]),
    listModels: () => Promise.resolve({ models: [modelId], error: null }),
    defaultSelection: () => Promise.resolve({ instanceId: 'inst_local_cli', modelId }),
    setDefault: () => Promise.resolve(true),
    rememberToolSupport: () => Promise.resolve(),
  };
};

describe('summarizing a meeting transcript through a local CLI agent', () => {
  it('runs Enhance over the recording and writes a summary artifact', async () => {
    const capture = path.join(scratch, 'prompt.txt');
    const db = makeDb();
    await seedSystemSkills(db);
    const { noteId, recordingId } = await seedMeetingNote(db);

    const result = await runSkill(
      {
        db,
        ai: makeCliAiPort(writeStubCli(capture)),
        locale: 'en',
        log: () => undefined,
      },
      ENHANCE_SKILL_ID,
      { noteId, recordingId }
    );

    assert.strictEqual(result.status, 200, JSON.stringify(result.body));

    // The transcript reached the model as speaker-labelled lines.
    const prompt = readFileSync(capture, 'utf8');
    expect(prompt).toContain('billing revamp');
    expect(prompt).toContain('load test');
    expect(prompt).toContain('the 14th');

    // The summary came back as the proposal the editor renders.
    const proposal = result.body as {
      rawMarkdown: string;
      mode: string;
      skillId: string;
      modelId: string;
    };
    expect(proposal.rawMarkdown).toContain('Target launch: the 14th');
    expect(proposal.rawMarkdown).toContain('Load test owned by');
    expect(proposal.modelId).toBe('claude');

    // Accepting it is what puts the summary on the note — the second half of
    // the round trip the Enhance button makes.
    const accepted = await acceptSkillRun(db, {
      noteId,
      skillId: proposal.skillId,
      recordingId,
      mode: proposal.mode,
      content: proposal.rawMarkdown,
      rawMarkdown: proposal.rawMarkdown,
      modelId: proposal.modelId,
    });
    assert.strictEqual(accepted.status, 200, JSON.stringify(accepted.body));

    const artifacts = await db
      .select()
      .from(schema.artifact)
      .where(eq(schema.artifact.noteId, noteId));
    assert.lengthOf(artifacts, 1);
    expect(artifacts[0]?.content).toContain('Target launch: the 14th');
  }, 30_000);
});
