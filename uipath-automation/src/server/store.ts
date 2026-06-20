import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { v4 as uuid } from "uuid";
import type { IntakeJob, InvoiceDraft, JobEvent, JobStatus } from "../shared/invoice";
import { emptyDraft } from "../shared/invoice";

const DATA_DIR = path.resolve(process.cwd(), ".data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");

type JobPatch = Partial<Omit<IntakeJob, "jobId" | "createdAt">>;

export class JobStore {
  private jobs = new Map<string, IntakeJob>();
  private loaded = false;

  async init(): Promise<void> {
    await mkdir(UPLOAD_DIR, { recursive: true });
    if (this.loaded) return;

    try {
      const file = await readFile(JOBS_FILE, "utf-8");
      const parsed = JSON.parse(file) as IntakeJob[];
      this.jobs = new Map(parsed.map((job) => [job.jobId, job]));
    } catch {
      this.jobs = new Map();
      await this.persist();
    }

    this.loaded = true;
  }

  async create(draft: InvoiceDraft = emptyDraft()): Promise<IntakeJob> {
    await this.init();
    const now = new Date().toISOString();
    const job: IntakeJob = {
      jobId: uuid(),
      status: "uploaded",
      createdAt: now,
      updatedAt: now,
      draft,
      events: [{ at: now, level: "info", message: "Capture received." }]
    };
    this.jobs.set(job.jobId, job);
    await this.persist();
    return job;
  }

  async list(): Promise<IntakeJob[]> {
    await this.init();
    return Array.from(this.jobs.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(jobId: string): Promise<IntakeJob | undefined> {
    await this.init();
    return this.jobs.get(jobId);
  }

  async update(jobId: string, patch: JobPatch): Promise<IntakeJob> {
    await this.init();
    const current = this.jobs.get(jobId);
    if (!current) {
      throw new Error(`Job ${jobId} was not found.`);
    }

    const updated: IntakeJob = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    this.jobs.set(jobId, updated);
    await this.persist();
    return updated;
  }

  async setStatus(jobId: string, status: JobStatus, message?: string, level: JobEvent["level"] = "info"): Promise<IntakeJob> {
    const current = await this.get(jobId);
    if (!current) throw new Error(`Job ${jobId} was not found.`);

    const events = message
      ? [...current.events, { at: new Date().toISOString(), level, message }]
      : current.events;

    return this.update(jobId, { status, events });
  }

  async appendEvent(jobId: string, event: Omit<JobEvent, "at">): Promise<IntakeJob> {
    const current = await this.get(jobId);
    if (!current) throw new Error(`Job ${jobId} was not found.`);

    return this.update(jobId, {
      events: [...current.events, { at: new Date().toISOString(), ...event }]
    });
  }

  async claimNextForFill(): Promise<IntakeJob | undefined> {
    await this.init();
    const current = Array.from(this.jobs.values())
      .filter((job) => job.status === "ready_for_qoyod" || job.status === "ready_for_robot")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];

    if (!current) {
      return undefined;
    }

    const now = new Date().toISOString();
    const updated: IntakeJob = {
      ...current,
      status: "qoyod_filling",
      updatedAt: now,
      fill: {
        method: "chrome_extension",
        status: "claimed",
        claimedAt: now,
        updatedAt: now
      },
      events: [
        ...current.events,
        {
          at: now,
          level: "info",
          message: "Qoyod Chrome extension claimed this job for draft filling."
        }
      ]
    };

    this.jobs.set(current.jobId, updated);
    await this.persist();
    return updated;
  }

  private async persist(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(JOBS_FILE, JSON.stringify(Array.from(this.jobs.values()), null, 2));
  }
}

export const jobStore = new JobStore();
