'use strict';
// Automation flows — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly.
let
  _evalCondition, _flowSeqState, _substituteTokens, _syncFlowIntervals, broadcastFullState,
  flowBus, saveAppState, state;
let ctx;

const handlers = {
  // ─── Flow CRUD ────────────────────────────────────────────────────────────
  save_flow(msg, ws) {
    const flow = msg.data;
    if (!flow || !flow.id) return;
    const idx = state.flows.findIndex(f => f.id === flow.id);
    if (idx >= 0) state.flows[idx] = flow;
    else state.flows.push(flow);
    _syncFlowIntervals();
    saveAppState();
    broadcastFullState();
  },

  delete_flow(msg, ws) {
    const id = msg.data && msg.data.id;
    if (!id) return;
    if (_flowSeqState[id]) { clearTimeout(_flowSeqState[id].timeoutHandle); delete _flowSeqState[id]; }
    state.flows = state.flows.filter(f => f.id !== id);
    _syncFlowIntervals();
    saveAppState();
    broadcastFullState();
  },

  toggle_flow(msg, ws) {
    const id = msg.data && msg.data.id;
    const f = id && state.flows.find(f => f.id === id);
    if (f) {
      f.enabled = !f.enabled;
      if (!f.enabled && _flowSeqState[id]) { clearTimeout(_flowSeqState[id].timeoutHandle); delete _flowSeqState[id]; }
      _syncFlowIntervals();
      saveAppState();
      broadcastFullState();
    }
  },

  fire_flow_manual(msg, ws) {
    const id = msg.data && msg.data.id;
    flowBus.emit('manual', { flowId: id || '' });
  },

  reset_flow_var(msg, ws) {
    const varName = msg.data && msg.data.name;
    if (!state.flowVars) state.flowVars = {};
    if (varName) delete state.flowVars[varName];
    else state.flowVars = {};
    broadcastFullState();
  },

  flow_dry_run(msg, ws) {
    const drId = msg.data && msg.data.id;
    const drFlow = (state.flows || []).find(f => f.id === drId);
    if (!drFlow) return;
    const drLog = { flowId: drId, flowName: drFlow.name, conditions: [], actions: [], conditionsPassed: false };
    // Evaluate conditions
    const conds = drFlow.conditions || [];
    drLog.conditions = conds.map(c => ({
      type: c.type, params: c.params || {},
      passed: _evalCondition(c)
    }));
    drLog.conditionsPassed = !conds.length || drLog.conditions.every(c => c.passed);
    // Describe each action (with resolved tokens, no execution)
    const mockCtx = {};
    drLog.actions = (drFlow.actions || []).map((a, i) => {
      const rp = Object.fromEntries(Object.entries(a.params || {}).map(([k,v]) => [k, typeof v === 'string' ? _substituteTokens(v, mockCtx) : v]));
      return { index: i, type: a.type, delay: a.delay || 0, rawParams: a.params || {}, resolvedParams: rp };
    });
    ws.send(JSON.stringify({ type: 'flow_dry_run_result', data: drLog }));
  },
};

module.exports = function createFlowHandlers(c) {
  ctx = c;
  ({
    _evalCondition, _flowSeqState, _substituteTokens, _syncFlowIntervals, broadcastFullState,
    flowBus, saveAppState, state
  } = c);
  return handlers;
};
