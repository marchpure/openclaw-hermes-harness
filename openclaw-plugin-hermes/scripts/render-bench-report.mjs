import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const summaryPath = process.argv[2];
const resultsPath = process.argv[3];

if (!summaryPath || !resultsPath) {
  console.error("usage: node render-bench-report.mjs <summary.json> <results.json>");
  process.exit(1);
}

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const results = JSON.parse(readFileSync(resultsPath, "utf8"));
const outPath = join(summary.outDir, "report.md");

function rowsFor(runtimeId) {
  return results.filter((row) => row.runtime === runtimeId && row.phase === "final");
}

function avg(values) {
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
}

const sections = [];
sections.push(`# Hermes vs OpenClaw PI Runtime Benchmark`);
sections.push(``);
sections.push(`- Run ID: \`${summary.runId}\``);
sections.push(`- Iterations per case: \`${summary.iterations}\``);
sections.push(`- Artifact dir: \`${summary.outDir}\``);
sections.push(`- Scope: real local OpenClaw gateway + real Hermes ACP container, no mock`);
sections.push(``);

sections.push(`## Overall`);
for (const runtime of summary.runtimes) {
  const stats = summary.grouped[runtime.id];
  sections.push(
    `- ${runtime.label}: pass ${stats.passed}/${stats.total}, avg ${stats.avgMs} ms, p95 ${stats.p95Ms} ms, provider match ${stats.providerMatched}/${stats.total}`,
  );
}
sections.push(``);

sections.push(`## Case Breakdown`);
sections.push(`| Runtime | Case | Complexity | Category | Avg ms | Pass / Total |`);
sections.push(`| --- | --- | --- | --- | ---: | ---: |`);
for (const runtime of summary.runtimes) {
  const runtimeRows = rowsFor(runtime.id);
  const byCase = new Map();
  for (const row of runtimeRows) {
    const bucket = byCase.get(row.caseId) ?? [];
    bucket.push(row);
    byCase.set(row.caseId, bucket);
  }
  for (const [caseId, bucket] of byCase.entries()) {
    sections.push(
      `| ${runtime.label} | ${caseId} | ${bucket[0].complexity} | ${bucket[0].category} | ${avg(bucket.map((row) => row.durationMs))} | ${bucket.filter((row) => row.ok && row.providerOk).length}/${bucket.length} |`,
    );
  }
}
sections.push(``);

const failures = results.filter((row) => row.phase === "final" && !(row.ok && row.providerOk));
sections.push(`## Failures`);
if (!failures.length) {
  sections.push(`- No failing sample in this run.`);
} else {
  for (const row of failures) {
    sections.push(
      `- ${row.runtime} ${row.caseId} iteration ${row.iteration}: provider=${row.provider ?? "null"} model=${row.modelObserved ?? "null"} reason=${row.failureReason}`,
    );
  }
}
sections.push(``);

sections.push(`## Initial Conclusions`);
sections.push(`- If Hermes has lower pass rate in medium/heavy cases, inspect corresponding stderr logs under the artifact directory first.`);
sections.push(`- If Hermes has much higher avg/p95 but similar pass rate, prioritize ACP session reuse, execenv mirroring volume, and provider/model cold-start overhead.`);
sections.push(`- Browser probe is capability discovery only; it should not be interpreted as quality of browser task completion.`);
sections.push(``);

writeFileSync(outPath, `${sections.join("\n")}\n`, "utf8");
console.log(outPath);
