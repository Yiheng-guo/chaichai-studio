import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = path.resolve(process.env.STUDIO_DATA_DIR || path.join(ROOT, ".data"));
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const id = () => randomUUID();
export function jobDir(jobId) {
  if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new Error("无效的研究编号");
  return path.join(DATA, "projects", jobId);
}
export async function atomicJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(temp, filename);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
export async function saveJob(job) {
  await atomicJson(path.join(jobDir(job.id), "project.json"), job);
}
export async function loadJob(jobId) {
  return JSON.parse(await fs.readFile(path.join(jobDir(jobId), "project.json"), "utf8"));
}
export async function listJobs() {
  const directories = await fs.readdir(path.join(DATA, "projects")).catch(() => []);
  const jobs = await Promise.all(
    directories.filter((x) => /^[0-9a-f-]{36}$/.test(x)).map((x) => loadJob(x).catch(() => null)),
  );
  return jobs
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ id, name, mode, target, createdAt, updatedAt, status, progress, error, report }) => ({
      id,
      name,
      mode,
      target,
      createdAt,
      updatedAt,
      status,
      progress,
      error,
      summary: report?.summary,
      counts: report?.counts,
    }));
}
export async function recoverInterrupted() {
  for (const summary of await listJobs())
    if (["queued", "running", "cancelling"].includes(summary.status)) {
      const job = await loadJob(summary.id);
      job.status = "interrupted";
      job.error = "上次服务中断。已保留研究记录，可重试或查看已保存的证据。";
      await saveJob(job);
    }
}
