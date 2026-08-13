import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

export interface JournalRecord<T = unknown> {
  version: 1;
  seq: number;
  at: string;
  previousChecksum: string;
  type: string;
  payload: T;
  checksum: string;
}

const recordSchema = z.object({
  version: z.literal(1),
  seq: z.number().int().positive(),
  at: z.string().datetime(),
  previousChecksum: z.string(),
  type: z.string().min(1),
  payload: z.unknown(),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
});

function checksum(value: Omit<JournalRecord, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class ChecksummedJournal {
  readonly path: string;
  private records: JournalRecord[] = [];

  private constructor(path: string) {
    this.path = path;
  }

  static async open(path: string): Promise<ChecksummedJournal> {
    const journal = new ChecksummedJournal(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let text = "";
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let previousChecksum = "";
    for (const [index, line] of text.split("\n").entries()) {
      if (!line) continue;
      const parsed = recordSchema.parse(JSON.parse(line)) as JournalRecord;
      const { checksum: actual, ...unsigned } = parsed;
      if (
        parsed.seq !== journal.records.length + 1 ||
        parsed.previousChecksum !== previousChecksum ||
        checksum(unsigned) !== actual
      ) {
        throw new Error(`journal integrity failure at line ${index + 1}`);
      }
      journal.records.push(parsed);
      previousChecksum = actual;
    }
    return journal;
  }

  all(): readonly JournalRecord[] {
    return this.records;
  }

  async append<T>(type: string, payload: T): Promise<JournalRecord<T>> {
    const unsigned = {
      version: 1 as const,
      seq: this.records.length + 1,
      at: new Date().toISOString(),
      previousChecksum: this.records.at(-1)?.checksum ?? "",
      type,
      payload,
    };
    const record: JournalRecord<T> = {
      ...unsigned,
      checksum: checksum(unsigned),
    };
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.write(`${JSON.stringify(record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.records.push(record);
    return record;
  }

  async writeSnapshot<T>(value: T): Promise<void> {
    const path = join(dirname(this.path), "snapshot.json");
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  }
}
