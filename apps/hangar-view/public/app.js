import { BrowserControlError, BrowserControlSdk } from "/control-sdk.js";

const $ = (id) => document.getElementById(id);
const sdk = new BrowserControlSdk("");
const state = {
  agents: [],
  releases: [],
  selectedAgent: null,
  selectedRelease: null,
  run: null,
  runEtag: null,
  stopEvents: null,
  pendingIdentities: new Map(),
  drawerTrigger: null,
  confirm: null,
  confirmTrigger: null,
};
const avatar = (index) => ["🧑‍💻", "👩‍🔧", "🧑‍🚀", "👩‍💻", "🧑‍🔬"][index % 5];
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const emptyAt = (root, text) =>
  root.replaceChildren(element("div", "empty", text));

function showError(message, target = $("globalError")) {
  target.textContent = message;
  target.hidden = false;
}
function clearError(target = $("globalError")) {
  target.textContent = "";
  target.hidden = true;
}
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3500);
}
function setLive(kind, label) {
  $("room").dataset.live = kind;
  $("liveness").textContent = label;
}
function identityFor(key, ifMatch) {
  if (!state.pendingIdentities.has(key))
    state.pendingIdentities.set(key, {
      idempotencyKey: crypto.randomUUID(),
      ifMatch,
    });
  return state.pendingIdentities.get(key);
}
function settleIdentity(key, error) {
  if (!error || error instanceof BrowserControlError)
    state.pendingIdentities.delete(key);
}

async function boot() {
  if (
    !document.cookie
      .split("; ")
      .some((entry) => entry.startsWith("hangar_csrf="))
  ) {
    $("login").hidden = false;
    setLive("unknown", "等待认证");
    return;
  }
  try {
    await sdk.health();
    $("login").hidden = true;
    setLive("alive", "Hangar 活着");
    await loadAgents();
  } catch {
    $("login").hidden = false;
    setLive("unknown", "等待认证");
  }
}

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError($("loginError"));
  const input = $("bootstrap");
  let bootstrap = input.value;
  input.value = "";
  $("loginButton").disabled = true;
  $("loginForm").classList.add("loading");
  try {
    try {
      await sdk.establishSession(bootstrap);
    } catch (error) {
      if (
        error instanceof BrowserControlError &&
        error.status === 410 &&
        error.message
      )
        await sdk.renewSession(bootstrap, error.message);
      else throw error;
    }
    $("login").hidden = true;
    setLive("alive", "Hangar 活着");
    await loadAgents();
  } catch (error) {
    showError(
      error instanceof BrowserControlError
        ? `认证失败（${error.status ?? "protocol"}），请检查 bootstrap 后重试。`
        : "连接失败，请确认 server 正在运行后重试。",
      $("loginError"),
    );
  } finally {
    bootstrap = "";
    input.value = "";
    $("loginButton").disabled = false;
    $("loginForm").classList.remove("loading");
  }
});
$("reauth").onclick = () => {
  $("login").hidden = false;
  $("bootstrap").focus();
};

async function loadAgents() {
  clearError();
  const result = await sdk.listAgents();
  state.agents = result.data.agents;
  renderAgents();
}
function renderAgents() {
  const root = $("desks");
  root.replaceChildren();
  $("officeCount").textContent = `${state.agents.length} 名员工`;
  if (!state.agents.length) {
    emptyAt(root, "还没有 Agent。先发布 release，再回到这里。");
    return;
  }
  state.agents.forEach((agent, index) => {
    const button = element("button", "desk");
    button.type = "button";
    button.dataset.agent = agent.agentId;
    button.setAttribute(
      "aria-current",
      String(state.selectedAgent === agent.agentId),
    );
    const employee = element("span", "employee");
    const face = element("span", "avatar", avatar(index));
    face.setAttribute("aria-hidden", "true");
    employee.append(face, element("span", "monitor"));
    const plate = element("span", "plate");
    plate.append(
      element("strong", "", agent.agentId),
      element("span", "", `${agent.releaseCount} 个 release · 待命`),
    );
    button.append(employee, plate);
    button.onclick = () => openAgent(agent.agentId, button);
    root.append(button);
  });
  for (let index = state.agents.length; index < 3; index += 1) {
    const vacant = element("div", "desk vacant");
    vacant.setAttribute("aria-hidden", "true");
    const employee = element("span", "employee");
    employee.append(
      element("span", "avatar", "🪑"),
      element("span", "monitor"),
    );
    const plate = element("span", "plate");
    plate.append(
      element("strong", "", "空工位"),
      element("span", "", "等待新 Agent"),
    );
    vacant.append(employee, plate);
    root.append(vacant);
  }
}

async function openAgent(agentId, trigger) {
  state.drawerTrigger = trigger;
  state.selectedAgent = agentId;
  renderAgents();
  $("drawerTitle").textContent = agentId;
  $("drawerMeta").textContent = "Release-owned intents";
  $("drawer").classList.add("open");
  $("drawer").setAttribute("aria-hidden", "false");
  $("closeDrawer").focus();
  emptyAt($("releases"), "正在读取 releases…");
  try {
    const result = await sdk.listReleases(agentId);
    state.releases = result.data.releases;
    state.selectedRelease = state.releases[0] ?? null;
    renderReleases();
  } catch (error) {
    showError("无法读取 releases，请重新认证或稍后重试。", $("intentError"));
    emptyAt($("releases"), "Releases 暂不可用。");
  }
}
function closeDrawer() {
  state.stopEvents?.();
  state.stopEvents = null;
  $("drawer").classList.remove("open");
  $("drawer").setAttribute("aria-hidden", "true");
  state.drawerTrigger?.focus();
}
$("closeDrawer").onclick = closeDrawer;
$("drawerBackdrop").onclick = closeDrawer;
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if ($("confirm").classList.contains("open")) closeConfirm();
    else if ($("drawer").classList.contains("open")) closeDrawer();
    return;
  }
  if (event.key === "Tab" && $("confirm").classList.contains("open")) {
    const controls = [$("confirmCancel"), $("confirmAction")];
    const index = controls.indexOf(document.activeElement);
    if (event.shiftKey && index === 0) {
      event.preventDefault();
      controls[1].focus();
    } else if (!event.shiftKey && index === 1) {
      event.preventDefault();
      controls[0].focus();
    }
  }
});

function renderReleases() {
  const root = $("releases");
  root.replaceChildren();
  const select = $("intentSelect");
  select.replaceChildren();
  state.releases.forEach((release) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "release" + (release === state.selectedRelease ? " selected" : "");
    button.textContent = `${release.releaseId.slice(0, 12)} · ${release.intentDescriptors.length} intents`;
    button.onclick = () => {
      state.selectedRelease = release;
      renderReleases();
    };
    root.append(button);
  });
  for (const descriptor of state.selectedRelease?.intentDescriptors ?? []) {
    const option = document.createElement("option");
    option.value = descriptor.intentId;
    option.textContent = `${descriptor.intentId} · v${descriptor.descriptorVersion}`;
    select.append(option);
  }
  if (!select.options.length) {
    const option = document.createElement("option");
    option.textContent = "无可用 intent";
    option.disabled = true;
    select.append(option);
  }
}

$("intentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError($("intentError"));
  const release = state.selectedRelease;
  const descriptor = release?.intentDescriptors.find(
    (item) => item.intentId === $("intentSelect").value,
  );
  const trigger = $("trigger").value.trim();
  if (!release || !descriptor || !trigger) {
    showError("请选择 release/intent，并填写触发说明。", $("intentError"));
    return;
  }
  const op = `intent:${release.releaseId}:${descriptor.intentId}:${trigger}`;
  const identity = identityFor(op, release.etag);
  $("startIntent").disabled = true;
  try {
    const result = await sdk.submitIntent(
      state.selectedAgent,
      descriptor.intentId,
      {
        descriptorVersion: descriptor.descriptorVersion,
        executionMode: "shadow-evaluator",
        input: { trigger },
      },
      identity,
    );
    state.pendingIdentities.delete(op);
    state.run = result.data.result;
    state.runEtag = null;
    $("trigger").value = "";
    toast("Run 已创建");
    closeDrawer();
    await loadRun(state.run.runId);
  } catch (error) {
    settleIdentity(op, error);
    showError(
      error instanceof BrowserControlError
        ? `启动失败（${error.status ?? "protocol"} / ${error.message}）。相同操作会复用原 identity。`
        : "响应未知；再次提交会复用原 identity。",
      $("intentError"),
    );
  } finally {
    $("startIntent").disabled = false;
  }
});

async function refreshRunView(runId) {
  const result = await sdk.getRun(runId);
  state.run = {
    ...result.data.run,
    pendingApprovals: result.data.pendingApprovals,
  };
  state.runEtag = result.etag;
  renderRun();
}
async function loadRun(runId) {
  await refreshRunView(runId);
  startEvents(runId);
}
function renderRun() {
  if (!state.run) {
    $("activeRun").hidden = true;
    return;
  }
  $("activeRun").hidden = false;
  $("runTitle").textContent = `${state.run.agentId} · ${state.run.state}`;
  $("runId").textContent = state.run.runId;
  $("runState").textContent = state.run.state;
  $("runMeta").textContent =
    `Attempt ${state.run.currentAttempt} · ${state.run.attemptState}`;
  $("cancelRun").disabled = ["completed", "failed", "cancelled"].includes(
    state.run.state,
  );
  renderApprovals();
}
function renderApprovals() {
  const root = $("approvals");
  root.replaceChildren();
  for (const approval of state.run?.pendingApprovals ?? []) {
    const box = element("div", "approval");
    const actions = element("div", "approval-actions");
    const approve = element("button", "primary", "批准");
    approve.type = "button";
    const deny = element("button", "danger", "拒绝");
    deny.type = "button";
    approve.onclick = () =>
      confirmAction("批准此操作？", "批准", () => decide(approval, "approved"));
    deny.onclick = () =>
      confirmAction("拒绝此操作？", "拒绝", () => decide(approval, "denied"));
    actions.append(approve, deny);
    box.append(
      element("strong", "", "等待你的决定"),
      element("div", "", `${approval.operation} · ${approval.approvalId}`),
      actions,
    );
    root.append(box);
  }
}

function startEvents(runId) {
  state.stopEvents?.();
  $("timeline").replaceChildren();
  $("reconnect").hidden = true;
  state.stopEvents = sdk.streamEvents(
    runId,
    (event) => {
      const item = document.createElement("li");
      const when = document.createElement("time");
      when.textContent = event.id;
      const detail = document.createElement("span");
      detail.textContent = event.eventKind;
      item.append(when, detail);
      $("timeline").prepend(item);
      while ($("timeline").children.length > 50)
        $("timeline").lastElementChild.remove();
      if (
        [
          "effect-intent",
          "effect-approved",
          "approval-decided",
          "local-dispatch-result",
          "run-terminal",
          "cancel-requested",
        ].includes(event.eventKind)
      )
        void refreshRunView(runId);
    },
    () => {
      $("reconnect").hidden = false;
      showError("时间线已断开；Run 仍由 Control 继续执行。", $("globalError"));
    },
  );
}
$("reconnect").onclick = () => {
  clearError();
  if (state.run) startEvents(state.run.runId);
};

$("cancelRun").onclick = () =>
  confirmAction(
    "取消当前 Run？已 dispatch 的 Effect 仍会先完成 reconciliation。",
    "取消 Run",
    cancelRun,
  );
function confirmAction(message, label, action) {
  state.confirm = action;
  state.confirmTrigger = document.activeElement;
  $("confirmTitle").textContent = label;
  $("confirmMessage").textContent = message;
  $("confirmAction").textContent = label;
  $("confirm").classList.add("open");
  $("confirmAction").focus();
}
function closeConfirm() {
  $("confirm").classList.remove("open");
  state.confirm = null;
  state.confirmTrigger?.focus();
  state.confirmTrigger = null;
}
$("confirmCancel").onclick = closeConfirm;
$("confirmAction").onclick = async () => {
  const action = state.confirm;
  closeConfirm();
  if (action) await action();
};
async function cancelRun() {
  if (!state.run || !state.runEtag) return;
  const op = `cancel:${state.run.runId}`;
  const identity = identityFor(op, state.runEtag);
  try {
    await sdk.cancelRun(state.run.runId, identity);
    state.pendingIdentities.delete(op);
    toast("Cancel 已提交");
    await loadRun(state.run.runId);
  } catch (error) {
    settleIdentity(op, error);
    showError("Cancel 未确认；重试会复用原 identity。");
  }
}
async function decide(approval, decision) {
  if (!state.runEtag) return;
  const op = `decision:${approval.approvalId}:${decision}`;
  const identity = identityFor(op, state.runEtag);
  try {
    await sdk.decideApproval(approval.approvalId, decision, identity);
    state.pendingIdentities.delete(op);
    toast("Approval 已记录");
    await loadRun(state.run.runId);
  } catch (error) {
    settleIdentity(op, error);
    showError("决定未确认；重试会复用原 identity。");
  }
}

boot();
