const normalGraph = `
  <svg class="graph-svg" viewBox="0 0 1000 260" role="img" aria-label="8 个节点、7 条边的正常合成分支图">
    <g>
      <path class="link" d="M115 130H195"/><path class="link" d="M275 130L355 78"/>
      <path class="link fail" d="M275 130L355 195"/><path class="link" d="M435 78H510"/>
      <path class="link" d="M590 78H670"/><path class="link fail" d="M590 78L670 195"/>
      <path class="link" d="M750 78H835"/>
    </g>
    <g class="graph-node start"><rect x="35" y="104" width="80" height="52" rx="12"/><text x="75" y="124">N0</text><text class="sub" x="75" y="145">开始</text></g>
    <g class="graph-node choice"><rect x="195" y="104" width="80" height="52" rx="12"/><text x="235" y="124">N1</text><text class="sub" x="235" y="145">选择</text></g>
    <g class="graph-node"><rect x="355" y="52" width="80" height="52" rx="12"/><text x="395" y="72">N2</text><text class="sub" x="395" y="93">场景</text></g>
    <g class="graph-node failure"><rect x="355" y="169" width="80" height="52" rx="12"/><text x="395" y="189">F1</text><text class="sub" x="395" y="210">失败</text></g>
    <g class="graph-node choice"><rect x="510" y="52" width="80" height="52" rx="12"/><text x="550" y="72">N3</text><text class="sub" x="550" y="93">选择</text></g>
    <g class="graph-node"><rect x="670" y="52" width="80" height="52" rx="12"/><text x="710" y="72">N4</text><text class="sub" x="710" y="93">回收</text></g>
    <g class="graph-node failure"><rect x="670" y="169" width="80" height="52" rx="12"/><text x="710" y="189">F2</text><text class="sub" x="710" y="210">失败</text></g>
    <g class="graph-node ending"><rect x="835" y="52" width="80" height="52" rx="12"/><text x="875" y="72">N5</text><text class="sub" x="875" y="93">结局</text></g>
  </svg>`;

const badGraph = `
  <svg class="graph-svg" viewBox="0 0 1000 260" role="img" aria-label="4 个节点、2 条边，仅 1 个节点可达的 Bad Case 图">
    <path class="link error" d="M180 76H340"/><path class="link" d="M460 190H610"/>
    <path class="group-link" d="M400 134V160M400 160H810"/>
    <g class="graph-node start"><rect x="100" y="50" width="80" height="52" rx="12"/><text x="140" y="70">A</text><text class="sub" x="140" y="91">可达</text></g>
    <g class="graph-node error"><rect x="340" y="50" width="120" height="52" rx="12"/><text x="400" y="70">MISSING</text><text class="sub" x="400" y="91">不存在</text></g>
    <g class="graph-node choice"><rect x="380" y="164" width="80" height="52" rx="12"/><text x="420" y="184">B</text><text class="sub" x="420" y="205">不可达</text></g>
    <g class="graph-node"><rect x="610" y="164" width="80" height="52" rx="12"/><text x="650" y="184">C</text><text class="sub" x="650" y="205">死路</text></g>
    <g class="graph-node ending"><rect x="810" y="164" width="110" height="52" rx="12"/><text x="865" y="184">ORPHAN</text><text class="sub" x="865" y="205">不可达</text></g>
    <text class="graph-note" x="100" y="244">4 nodes · 2 edges · reachable 1 · failures 0</text>
  </svg>`;

const badEvidence = [
  ["EV-ONLY-001", "Beach color note", "与 castle banquet negotiation 无关键词命中", "0.0000", true]
];

const badVariables = [["broken_flag", "0%", "3 项生命周期问题", true]];

const badGates = [
  ["上下文相关性", "low · averageScore 0 · 1 条证据", "review"],
  ["图结构完整性", "5 项：悬空边、死路、不可达节点", "fail"],
  ["失败分支覆盖", "2 项：分支数不足、失败分支缺失", "fail"],
  ["变量生命周期", "3 项：read/settle 缺失、节点不存在", "fail"],
  ["证据与不确定性回溯", "PASS · 0 项不确定性", "pass"]
];

const scenarios = {
  normal: {
    status: "pass",
    statusText: "质量门通过",
    metrics: ["3", "8", "2/2", "PASS"],
    metricDetails: ["/ 4 条合成证据", "节点 · 7 条边 · 可达 8", "2 个选择 · 2 个失败节点", "1 项不确定性已保留"],
    confidence: ["中置信", "amber"],
    graphBadge: ["结构有效", "green"],
    review: "策略复审未触发",
    uncertainty: "虚构公共日志版本号未指定，需要人工复核。",
    evidence: [
      ["EV-CANON-001", "Lighthouse power rule", "灯塔供电与潮汐地图规则", "0.6400"],
      ["EV-FLOW-002", "Failure route behavior", "电量不足与失败路线行为", "0.3857"],
      ["EV-REF-003", "Tide map provenance", "潮汐地图来源与回执要求", "0.3257"]
    ],
    variables: [["beacon_charge", "100%", "生命周期完整", false], ["tide_map_verified", "100%", "生命周期完整", false]],
    gates: [
      ["上下文相关性", "PASS · medium · averageScore 0.4505", "pass"],
      ["图结构完整性", "PASS · 8 节点 / 7 边 / 可达 8", "pass"],
      ["失败分支覆盖", "PASS · 2 个选择 / 2 个失败节点", "pass"],
      ["变量生命周期", "PASS · 2/2 完整", "pass"],
      ["证据与不确定性回溯", "PASS · 1 项不确定性", "pass"]
    ],
    callout: null,
    graphMarkup: normalGraph,
    receipt: ["PASS", "rcpt_73b2c8e6b1bf5136", "8ca376…4259", "42b147…f3d2", "accepted / review not triggered"]
  },
  badcase: {
    status: "fail",
    statusText: "3 个硬失败门 · 1 项复核标记",
    metrics: ["1", "4", "0/1", "PASS"],
    metricDetails: ["/ 1 条合成证据 · 得分 0", "节点 · 2 条边 · 可达 1", "1 个选择 · 0 个失败节点", "0 项不确定性"],
    confidence: ["低置信", "red"],
    graphBadge: ["7 项图问题", "red"],
    review: "策略复审已触发 · blocked",
    uncertainty: "未记录不确定项；上下文相关性仍被标记为需要复核。",
    evidence: badEvidence,
    variables: badVariables,
    gates: badGates,
    callout: ["真实结果：7 个图问题、3 个变量问题；已生成 6 条修复计划。系统未修改输入，需人工确认后修改并重新运行。", "error"],
    graphMarkup: badGraph,
    receipt: ["FAIL", "rcpt_c956b2a1a0999b7f", "560549…e18d", "4e585b…41e7", "blocked / repair plan only"]
  },
  plan: {
    status: "review",
    statusText: "修复计划待人工确认",
    metrics: ["1", "4", "0/1", "PASS"],
    metricDetails: ["/ 1 条合成证据 · 得分 0", "节点 · 2 条边 · 可达 1", "1 个选择 · 0 个失败节点", "输入与回执均未改变"],
    confidence: ["低置信", "red"],
    graphBadge: ["输入未修改", "amber"],
    review: "仅生成计划 · 尚未重新运行",
    uncertainty: "修复计划不会覆盖原输入；人工修改后必须重新运行全部质量门。",
    evidence: badEvidence,
    variables: badVariables,
    gates: badGates,
    callout: ["6 条计划预览：补充或重标证据；修正悬空引用；连接或移除不可达节点；处理死路；补齐选择与失败路径；补全变量生命周期。待人工确认、修改输入并重新运行。", "plan"],
    graphMarkup: badGraph,
    receipt: ["FAIL", "rcpt_c956b2a1a0999b7f", "560549…e18d", "4e585b…41e7", "unchanged / rerun required"]
  }
};

const $ = (selector) => document.querySelector(selector);

function render(mode) {
  const data = scenarios[mode];
  document.querySelectorAll(".scenario").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });

  const status = $("#runStatus");
  status.className = `run-status ${data.status}`;
  status.querySelector("span").textContent = data.statusText;

  ["#metricEvidence", "#metricGraph", "#metricFailure", "#metricTrace"].forEach((id, index) => {
    $(id).textContent = data.metrics[index];
  });
  ["#metricEvidenceDetail", "#metricGraphDetail", "#metricFailureDetail", "#metricTraceDetail"].forEach((id, index) => {
    $(id).textContent = data.metricDetails[index];
  });

  const confidence = $("#confidenceBadge");
  confidence.textContent = data.confidence[0];
  confidence.className = `chip ${data.confidence[1]}`;
  const graph = $("#graphBadge");
  graph.textContent = data.graphBadge[0];
  graph.className = `chip ${data.graphBadge[1]}`;
  $("#reviewBadge").textContent = data.review;
  $("#uncertaintyText").textContent = data.uncertainty;
  $("#miniGraph").innerHTML = data.graphMarkup;

  $("#evidenceList").innerHTML = data.evidence.map((item) => `
    <div class="evidence-item ${item[4] ? "off" : ""}">
      <span>${item[0]}</span>
      <div><b>${item[1]}</b><small>${item[2]}</small></div>
      <em>${item[3]}</em>
    </div>
  `).join("");

  $("#variableRows").innerHTML = data.variables.map((item) => `
    <div class="variable-row ${item[3] ? "bad" : ""}">
      <code>${item[0]}</code>
      <div class="life-track"><span style="width:${item[1]}"></span></div>
      <em>${item[2]}</em>
    </div>
  `).join("");

  $("#gateList").innerHTML = data.gates.map((item) => `
    <div class="gate ${item[2]}">
      <div class="gate-top"><b>${item[0]}</b><i></i></div>
      <small>${item[1]}</small>
    </div>
  `).join("");

  const callout = $("#repairCallout");
  if (!data.callout) {
    callout.className = "repair-callout hidden";
    callout.textContent = "";
  } else {
    callout.className = `repair-callout ${data.callout[1]}`;
    callout.textContent = data.callout[0];
  }

  const [state, runId, contextHash, snapshotHash, policy] = data.receipt;
  $("#receiptState").textContent = state;
  $("#receiptState").style.color = state === "PASS" ? "var(--mint)" : "var(--red)";
  $("#runId").textContent = runId;
  $("#contextHash").textContent = contextHash;
  $("#snapshotHash").textContent = snapshotHash;
  $("#policyText").textContent = policy;
}

document.querySelectorAll(".scenario").forEach((button) => {
  button.addEventListener("click", () => render(button.dataset.mode));
});

const requestedMode = new URLSearchParams(window.location.search).get("mode");
render(Object.hasOwn(scenarios, requestedMode) ? requestedMode : "normal");
