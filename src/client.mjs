const base = `http://127.0.0.1:${Number(process.env.PORT || 5197)}`;
export async function studioRequest(route, { method = "GET", data } = {}) {
  let bootstrap;
  try {
    const res = await fetch(`${base}/api/bootstrap`, { signal: AbortSignal.timeout(4000) });
    bootstrap = await res.json();
  } catch {
    throw new Error(`研究台服务尚未运行，请先执行 npm start（${base}）。`);
  }
  const response = await fetch(base + route, {
    method,
    headers: { "X-Studio-Token": bootstrap.token, "Content-Type": "application/json" },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "请求未完成");
  return json;
}
export function projectView(job, section = "summary", offset = 0, limit = 20) {
  const metadata = {
    id: job.id,
    name: job.name,
    mode: job.mode,
    status: job.status,
    progress: job.progress,
    error: job.error || null,
  };
  if (!job.report) return metadata;
  const report = job.report;
  if (section === "summary")
    return {
      ...metadata,
      summary: report.summary,
      counts: report.counts,
      unknowns: report.unknowns,
      limitations: report.limitations,
      coverage: report.coverage,
      engine: {
        connected: report.engine.connected,
        evidenceId: report.engine.evidenceId,
        semanticUnknowns: report.engine.semanticUnknowns,
      },
    };
  const collections = {
    technology: report.tech,
    features: report.features,
    workflows: report.workflows,
    delivery: report.delivery,
    functions: report.functions,
    changes: report.changes?.files || [],
    evidence: report.evidence,
  };
  if (!Object.hasOwn(collections, section)) throw new Error("未知的研究视图");
  const items = collections[section];
  const page = items.slice(offset, offset + limit).map((item) => {
    if (section !== "changes") return item;
    const { diff, ...summary } = item;
    return { ...summary, projection: "文件变化摘要；完整差异见工作台报告" };
  });
  return {
    ...metadata,
    section,
    offset,
    total: items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null,
    items: page,
    limitations: report.limitations,
  };
}
