'use strict';

const { fail, exact, key, id, ids, text, hash, clone, opaque, instant, period, money, authorize } = require('./core');
const { FileStore, audit } = require('./store');
const { YandexAdapters, validatePatch } = require('./adapters');

const DEFAULT_POLICY = Object.freeze({ version: 0, mode: 'observe', period: null,
  currency: null, maxBudgetMinor: null, allocations: [], allowedAdIds: [] });
const accountResource = (connection) => hash(['direct-account', connection.accountId]);
const objectKey = (accountId, kind, objectId) => hash([accountId, kind, objectId]);
const safeCode = (error) => error?.name === 'IntegrationError' ? error.code : 'INTERNAL_FAILURE';

class YandexIntegration {
  #store;
  #adapters;
  #now;
  constructor({ directory, transport, resolveSecret, now = () => Date.now() }) {
    this.#store = new FileStore(directory);
    this.#adapters = new YandexAdapters({ transport, resolveSecret });
    this.#now = now;
  }
  #stamp() { return new Date(this.#now()).toISOString(); }
  #revokeCaptured(state, captured) {
    const connection = captured && state.connections[captured.id];
    if (!connection || connection.version !== captured.version) return false;
    connection.active = false; connection.version += 1;
    return true;
  }
  #recordAccessFailure(actor, companyId, captured, error) {
    if (safeCode(error) === 'ACCESS_REVOKED') {
      this.#store.transaction((state) => {
        const revoked = this.#revokeCaptured(state, captured);
        audit(state, actor, companyId, revoked ? 'CONNECTION_ACCESS_REVOKED' : 'STALE_ACCESS_FAILURE', {
          connectionId: captured.id, connectionVersion: captured.version });
      });
    }
    throw error;
  }
  #context(state, companyId) {
    const binding = state.bindings[companyId];
    const connection = binding && state.connections[binding.connectionId];
    if (!state.profiles[companyId] || !binding || !connection || !connection.active ||
        !connection.companyIds.includes(companyId) || binding.accountId !== connection.accountId) fail('CONNECTION_NOT_AVAILABLE');
    return { ...connection, companyId, connectionId: connection.id, bindingVersion: binding.version };
  }
  #reserve(actor, companyId, expected, service, consume = true) {
    this.#store.transaction((state) => {
      authorize(actor, companyId, 'ads.read');
      const context = this.#context(state, companyId);
      if (hash(context) !== hash(expected)) fail('CONNECTION_CHANGED');
      if (!consume) return;
      const quotaKeys = [hash(['principal', context.principalId, service]),
        hash(['account', context.accountId, service])];
      for (const quotaKey of quotaKeys) {
        const quota = state.quotas[quotaKey] || { used: 0, start: this.#now() };
        if (this.#now() - quota.start >= context.quota.windowMs) { quota.used = 0; quota.start = this.#now(); }
        if (quota.used >= context.quota.limit) fail('QUOTA_EXCEEDED');
        quota.used += 1;
        state.quotas[quotaKey] = quota;
      }
    });
  }
  saveProfile(actor, input) {
    exact(input, ['companyId', 'label', 'siteHosts', 'methodologyVersion', 'region', 'goalMeaning', 'capacity', 'businessFacts']);
    const companyId = key(input.companyId);
    authorize(actor, companyId, 'ads.configure');
    if (!Array.isArray(input.siteHosts) || !input.siteHosts.length || input.siteHosts.length > 30) fail('INVALID_HOSTS');
    const hosts = input.siteHosts.map((host) => {
      const value = text(host, 253).toLowerCase();
      if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(value)) fail('INVALID_HOST');
      return value;
    });
    const profile = { companyId, label: text(input.label), siteHosts: [...new Set(hosts)].sort(),
      methodologyVersion: text(input.methodologyVersion, 128) };
    for (const field of ['region', 'goalMeaning', 'capacity']) if (input[field] !== undefined) profile[field] = text(input[field], 1024);
    if (input.businessFacts !== undefined) {
      if (!Array.isArray(input.businessFacts) || input.businessFacts.length > 100) fail('INVALID_FACTS');
      profile.businessFacts = input.businessFacts.map((fact) => {
        exact(fact, ['kind', 'value', 'source', 'verifiedAt']);
        return { kind: key(fact.kind), value: text(fact.value, 2048), source: text(fact.source, 2048), verifiedAt: instant(fact.verifiedAt) };
      });
    }
    return this.#store.transaction((state) => {
      state.profiles[companyId] = profile;
      audit(state, actor, companyId, 'PROFILE_SAVED', { profileHash: hash(profile) });
      return profile;
    });
  }
  registerConnection(actor, input) {
    exact(input, ['id', 'principalId', 'accountId', 'clientLogin', 'secretRef', 'companyIds', 'active', 'verifiedAt', 'quota']);
    if (actor?.kind !== 'human') fail('HUMAN_REQUIRED');
    if (!Array.isArray(input.companyIds) || !input.companyIds.length) fail('INVALID_COMPANIES');
    const companyIds = [...new Set(input.companyIds.map(key))].sort();
    companyIds.forEach((companyId) => authorize(actor, companyId, 'ads.configure'));
    exact(input.quota, ['limit', 'windowMs']);
    if (!Number.isSafeInteger(input.quota.limit) || input.quota.limit < 1 ||
        !Number.isSafeInteger(input.quota.windowMs) || input.quota.windowMs < 1000) fail('INVALID_QUOTA');
    if (typeof input.active !== 'boolean') fail('INVALID_CONNECTION_STATE');
    const connection = { id: key(input.id), principalId: key(input.principalId), accountId: key(input.accountId),
      clientLogin: key(input.clientLogin), secretRef: key(input.secretRef), companyIds,
      active: input.active, verifiedAt: input.verifiedAt ? instant(input.verifiedAt) : null, quota: clone(input.quota) };
    return this.#store.transaction((state) => {
      const previous = state.connections[connection.id];
      if (previous && previous.companyIds.some((companyId) => !actor.companyIds.includes(companyId))) fail('FORBIDDEN');
      for (const other of Object.values(state.connections)) {
        if ((other.principalId === connection.principalId || other.accountId === connection.accountId) && hash(other.quota) !== hash(connection.quota)) fail('SHARED_QUOTA_MISMATCH');
      }
      connection.version = (previous?.version || 0) + 1;
      state.connections[connection.id] = connection;
      companyIds.forEach((companyId) => audit(state, actor, companyId, 'CONNECTION_METADATA_SAVED', { connectionId: connection.id }));
      return { id: connection.id, version: connection.version };
    });
  }
  saveBindings(actor, companyId, input) {
    authorize(actor, companyId, 'ads.configure');
    exact(input, ['connectionId', 'accountId', 'campaignIds', 'counterIds']);
    const binding = { connectionId: key(input.connectionId), accountId: key(input.accountId),
      campaignIds: ids(input.campaignIds), counterIds: ids(input.counterIds) };
    return this.#store.transaction((state) => {
      if (!state.profiles[companyId]) fail('PROFILE_REQUIRED');
      const connection = state.connections[binding.connectionId];
      if (!connection || !connection.companyIds.includes(companyId) || connection.accountId !== binding.accountId) fail('BINDING_FORBIDDEN');
      for (const [otherCompany, other] of Object.entries(state.bindings)) {
        if (otherCompany !== companyId && other.accountId === binding.accountId &&
            other.campaignIds.some((campaignId) => binding.campaignIds.includes(campaignId))) fail('OBJECT_ALREADY_BOUND');
        if (otherCompany !== companyId && other.counterIds.some((counterId) => binding.counterIds.includes(counterId))) fail('COUNTER_ALREADY_BOUND');
      }
      if (state.bindings[companyId] && hash({ ...state.bindings[companyId], version: 0 }) === hash({ ...binding, version: 0 })) return state.bindings[companyId];
      binding.version = (state.bindings[companyId]?.version || 0) + 1;
      state.bindings[companyId] = binding;
      audit(state, actor, companyId, 'BINDINGS_SAVED', { bindingHash: hash(binding) });
      return binding;
    });
  }
  setPolicy(actor, companyId, input) {
    authorize(actor, companyId, 'ads.configure');
    if (actor.kind !== 'human') fail('HUMAN_REQUIRED');
    exact(input, ['mode', 'period', 'currency', 'maxBudgetMinor', 'allocations', 'allowedAdIds']);
    if (!['observe', 'draft'].includes(input.mode)) fail('UNSUPPORTED_MODE');
    const policy = { mode: input.mode, period: period(input.period), currency: text(input.currency, 3),
      maxBudgetMinor: money(input.maxBudgetMinor), allowedAdIds: ids(input.allowedAdIds), allocations: [] };
    if (!/^[A-Z]{3}$/.test(policy.currency) || !Array.isArray(input.allocations)) fail('INVALID_BUDGET');
    policy.allocations = input.allocations.map((entry) => {
      exact(entry, ['campaignId', 'budgetMinor']);
      return { campaignId: id(entry.campaignId), budgetMinor: money(entry.budgetMinor) };
    }).sort((a, b) => a.campaignId.localeCompare(b.campaignId));
    if (new Set(policy.allocations.map((entry) => entry.campaignId)).size !== policy.allocations.length ||
        policy.allocations.reduce((sum, entry) => sum + BigInt(entry.budgetMinor), 0n) > BigInt(policy.maxBudgetMinor)) fail('TOTAL_BUDGET_EXCEEDED');
    return this.#store.transaction((state) => {
      this.#context(state, companyId);
      const binding = state.bindings[companyId];
      if (policy.allocations.some((entry) => !binding.campaignIds.includes(entry.campaignId))) fail('CAMPAIGN_NOT_BOUND');
      for (const adId of policy.allowedAdIds) {
        const row = state.objects[objectKey(binding.accountId, 'ad', adId)];
        if (!row || row.companyId !== companyId || row.bindingVersion !== binding.version) fail('AD_NOT_IMPORTED');
      }
      policy.version = (state.policies[companyId]?.version || 0) + 1;
      state.policies[companyId] = policy;
      audit(state, actor, companyId, 'POLICY_SAVED', { policyHash: hash(policy) });
      return policy;
    });
  }
  async importExisting(actor, companyId, selection) {
    authorize(actor, companyId, 'ads.read');
    exact(selection, ['campaignIds', 'adIds']);
    const selected = { campaignIds: ids(selection.campaignIds), adIds: ids(selection.adIds) };
    const context = this.#store.read((state) => {
      const context = this.#context(state, companyId);
      if (selected.campaignIds.some((campaignId) => !state.bindings[companyId].campaignIds.includes(campaignId))) fail('CAMPAIGN_NOT_BOUND');
      return context;
    });
    let objects;
    try {
      objects = await this.#adapters.readObjects(context, selected, (service, consume) => this.#reserve(actor, companyId, context, service, consume));
    } catch (error) { this.#recordAccessFailure(actor, companyId, context, error); }
    return this.#store.transaction((state) => {
      if (hash(this.#context(state, companyId)) !== hash(context)) fail('CONNECTION_CHANGED');
      for (const [kind, rows] of [['campaign', objects.campaigns], ['ad', objects.ads]]) {
        for (const data of rows) {
          const recordKey = objectKey(context.accountId, kind, data.Id);
          if (state.objects[recordKey] && state.objects[recordKey].companyId !== companyId) fail('OBJECT_ALREADY_BOUND');
          state.objects[recordKey] = { companyId, bindingVersion: context.bindingVersion, connectionVersion: context.version, kind, data, capturedAt: this.#stamp() };
        }
      }
      audit(state, actor, companyId, 'OBJECTS_IMPORTED', { snapshotHash: hash(objects) });
      return objects;
    });
  }
  #basis(state, companyId, adId) {
    const context = this.#context(state, companyId);
    const binding = state.bindings[companyId];
    const adRow = state.objects[objectKey(binding.accountId, 'ad', adId)];
    const campaignRow = adRow && state.objects[objectKey(binding.accountId, 'campaign', adRow.data.CampaignId)];
    if (!adRow || !campaignRow || adRow.companyId !== companyId || campaignRow.companyId !== companyId ||
        adRow.bindingVersion !== binding.version || campaignRow.bindingVersion !== binding.version ||
        adRow.connectionVersion !== context.version || campaignRow.connectionVersion !== context.version ||
        !binding.campaignIds.includes(adRow.data.CampaignId)) fail('AD_NOT_IMPORTED');
    return { context, binding, profile: state.profiles[companyId], policy: state.policies[companyId] || clone(DEFAULT_POLICY),
      ad: adRow.data, campaign: campaignRow.data };
  }
  #checkDraft(basis) {
    if (!basis.context.verifiedAt) fail('CONNECTION_UNVERIFIED');
    if (basis.policy.mode !== 'draft') fail('READ_ONLY');
    if (basis.ad.Status !== 'DRAFT' || basis.campaign.Status !== 'DRAFT' || basis.ad.State !== 'OFF' || basis.campaign.State !== 'OFF') fail('DRAFT_ONLY');
    if (!basis.policy.allowedAdIds.includes(basis.ad.Id) || !basis.policy.allocations.some((row) => row.campaignId === basis.campaign.Id)) fail('OBJECT_NOT_PERMITTED');
    if (basis.policy.currency !== basis.campaign.Currency) fail('CURRENCY_MISMATCH');
  }
  #baseHash(basis) {
    const { secretRef: _secretRef, ...publicContext } = basis.context;
    return hash({ context: publicContext, binding: basis.binding, profile: basis.profile, ad: basis.ad, campaign: basis.campaign });
  }
  createProposal(actor, companyId, input) {
    authorize(actor, companyId, 'ads.propose');
    exact(input, ['adId', 'patch', 'expiresAt']);
    const adId = id(input.adId);
    const expiresAt = instant(input.expiresAt);
    if (Date.parse(expiresAt) <= this.#now()) fail('APPROVAL_EXPIRED');
    return this.#store.transaction((state) => {
      const basis = this.#basis(state, companyId, adId);
      validatePatch(input.patch, basis.ad, basis.profile.siteHosts);
      const proposal = { id: opaque(), companyId, adId, patch: clone(input.patch), expiresAt,
        proposerId: actor.id, baseHash: this.#baseHash(basis), policyHash: hash(basis.policy),
        period: basis.policy.period, maxBudgetMinor: basis.policy.maxBudgetMinor,
        objectIds: [basis.campaign.Id, basis.ad.AdGroupId, adId] };
      proposal.digest = hash(proposal);
      proposal.status = 'proposed';
      state.proposals[proposal.id] = proposal;
      audit(state, actor, companyId, 'PROPOSAL_CREATED', { proposalId: proposal.id, digest: proposal.digest });
      return proposal;
    });
  }
  #proposal(state, companyId, proposalId, digest) {
    const proposal = state.proposals[key(proposalId)];
    if (!proposal || proposal.companyId !== companyId || proposal.digest !== digest) fail('PROPOSAL_NOT_FOUND');
    const basis = this.#basis(state, companyId, proposal.adId);
    if (Date.parse(proposal.expiresAt) <= this.#now()) fail('APPROVAL_EXPIRED');
    if (proposal.baseHash !== this.#baseHash(basis) || proposal.policyHash !== hash(basis.policy)) fail('STALE_APPROVAL');
    return { proposal, basis };
  }
  approveProposal(actor, companyId, proposalId, digest) {
    authorize(actor, companyId, 'ads.approve');
    if (actor.kind !== 'human') fail('HUMAN_REQUIRED');
    return this.#store.transaction((state) => {
      const { proposal, basis } = this.#proposal(state, companyId, proposalId, digest);
      this.#checkDraft(basis);
      if (proposal.proposerId === actor.id) fail('SELF_APPROVAL_FORBIDDEN');
      const approval = { proposalId, digest, actorId: actor.id, approvedAt: this.#stamp(), expiresAt: proposal.expiresAt };
      state.approvals[proposalId] = approval;
      proposal.status = 'approved';
      audit(state, actor, companyId, 'PROPOSAL_APPROVED', { proposalId, digest });
      return approval;
    });
  }
  enqueueProposal(actor, companyId, proposalId, digest) {
    authorize(actor, companyId, 'ads.execute');
    return this.#store.transaction((state) => {
      const jobId = hash([companyId, proposalId, digest]);
      if (state.jobs[jobId]) return state.jobs[jobId];
      const { proposal, basis } = this.#proposal(state, companyId, proposalId, digest);
      this.#checkDraft(basis);
      if (state.approvals[proposalId]?.digest !== digest) fail('APPROVAL_REQUIRED');
      const job = { id: jobId, companyId, proposalId, digest, state: 'queued',
        resource: accountResource(basis.context), createdAt: this.#stamp(), updatedAt: this.#stamp() };
      state.jobs[jobId] = job;
      proposal.status = 'queued';
      audit(state, actor, companyId, 'JOB_QUEUED', { jobId, proposalId });
      return job;
    });
  }
  claim(actor, companyId, workerId, leaseMs = 60000) {
    authorize(actor, companyId, 'ads.execute');
    key(workerId);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000) fail('INVALID_LEASE');
    return this.#store.transaction((state) => {
      for (const job of Object.values(state.jobs)) {
        if (job.companyId !== companyId || !['claimed', 'writing'].includes(job.state) || job.leaseUntil > this.#now()) continue;
        if (job.state === 'writing') { job.state = 'unknown'; job.code = 'EXPIRED_WRITE_LEASE'; }
        else {
          job.state = 'queued';
          if (state.resources[job.resource]?.jobId === job.id) delete state.resources[job.resource];
        }
      }
      const job = Object.values(state.jobs).find((row) => row.companyId === companyId && row.state === 'queued' && !state.resources[row.resource]);
      if (!job) return null;
      job.state = 'claimed'; job.workerId = workerId; job.leaseToken = opaque(); job.leaseUntil = this.#now() + leaseMs;
      job.updatedAt = this.#stamp();
      state.resources[job.resource] = { jobId: job.id, token: job.leaseToken };
      return job;
    });
  }
  #held(state, job, states) {
    const current = state.jobs[job.id];
    if (!current || current.companyId !== job.companyId || current.leaseToken !== job.leaseToken ||
        current.leaseUntil <= this.#now() || !states.includes(current.state) ||
        state.resources[current.resource]?.token !== job.leaseToken) fail('LEASE_LOST');
    return current;
  }
  async #fresh(actor, job, capture = () => {}) {
    const basis = this.#store.read((state) => this.#basis(state, job.companyId, state.proposals[job.proposalId].adId));
    capture({ id: basis.context.id, version: basis.context.version });
    const objects = await this.#adapters.readObjects(basis.context, {
      campaignIds: [basis.campaign.Id], adIds: [basis.ad.Id] },
    (service, consume) => this.#reserve(actor, job.companyId, basis.context, service, consume));
    return { ...basis, ad: objects.ads[0], campaign: objects.campaigns[0] };
  }
  async runNext(actor, companyId, workerId) {
    const job = this.claim(actor, companyId, workerId);
    if (!job) return null;
    let writing = false;
    let requestConnection;
    try {
      const fresh = await this.#fresh(actor, job, (captured) => { requestConnection = captured; });
      const prepared = this.#store.transaction((state) => {
        const current = this.#held(state, job, ['claimed']);
        const { proposal, basis } = this.#proposal(state, companyId, job.proposalId, job.digest);
        this.#checkDraft(fresh);
        if (this.#baseHash(fresh) !== proposal.baseHash || this.#baseHash(basis) !== proposal.baseHash) fail('STALE_APPROVAL');
        if (state.approvals[proposal.id]?.digest !== proposal.digest) fail('APPROVAL_REQUIRED');
        const expected = validatePatch(proposal.patch, fresh.ad, fresh.profile.siteHosts);
        current.expectedAdHash = hash(expected); current.state = 'writing'; current.updatedAt = this.#stamp();
        audit(state, actor, companyId, 'WRITE_STARTED', { jobId: job.id, expectedAdHash: current.expectedAdHash });
        return { context: fresh.context, adId: fresh.ad.Id, patch: proposal.patch, expectedAdHash: current.expectedAdHash };
      });
      writing = true;
      requestConnection = { id: prepared.context.id, version: prepared.context.version };
      await this.#adapters.updateResponsive(prepared.context, prepared.adId, prepared.patch,
        (service, consume) => this.#reserve(actor, companyId, prepared.context, service, consume),
        () => this.#store.transaction((state) => {
          this.#held(state, job, ['writing']);
          const { proposal, basis } = this.#proposal(state, companyId, job.proposalId, job.digest);
          this.#checkDraft(basis);
          if (state.approvals[proposal.id]?.digest !== proposal.digest || hash(basis.context) !== hash(prepared.context)) fail('APPROVAL_REQUIRED');
        }));
      const after = await this.#fresh(actor, job, (captured) => { requestConnection = captured; });
      if (hash(after.ad) !== prepared.expectedAdHash || after.campaign.Status !== 'DRAFT' || after.campaign.State !== 'OFF') fail('READBACK_MISMATCH');
      return this.#store.transaction((state) => {
        const current = this.#held(state, job, ['writing']);
        current.state = 'completed'; current.updatedAt = this.#stamp();
        const rowKey = objectKey(prepared.context.accountId, 'ad', prepared.adId);
        state.objects[rowKey].data = after.ad;
        state.proposals[job.proposalId].status = 'completed';
        delete state.resources[current.resource];
        audit(state, actor, companyId, 'WRITE_VERIFIED', { jobId: job.id, afterHash: hash(after.ad) });
        return current;
      });
    } catch (error) {
      return this.#store.transaction((state) => {
        const current = state.jobs[job.id];
        if (current.leaseToken !== job.leaseToken || !['claimed', 'writing'].includes(current.state)) return current;
        current.state = writing ? 'unknown' : 'blocked'; current.code = safeCode(error); current.updatedAt = this.#stamp();
        if (!writing) delete state.resources[current.resource];
        if (current.code === 'ACCESS_REVOKED') {
          const revoked = this.#revokeCaptured(state, requestConnection);
          audit(state, actor, companyId, revoked ? 'CONNECTION_ACCESS_REVOKED' : 'STALE_ACCESS_FAILURE', {
            connectionId: requestConnection.id, connectionVersion: requestConnection.version });
        }
        audit(state, actor, companyId, writing ? 'WRITE_UNKNOWN' : 'JOB_BLOCKED', { jobId: job.id, code: current.code });
        return current;
      });
    }
  }
  async reconcileUnknown(actor, companyId, jobId) {
    authorize(actor, companyId, 'ads.reconcile');
    const job = this.#store.read((state) => {
      const job = state.jobs[key(jobId)];
      if (!job || job.companyId !== companyId || job.state !== 'unknown') fail('UNKNOWN_JOB_REQUIRED');
      return job;
    });
    const fresh = await this.#fresh(actor, job);
    return this.#store.transaction((state) => {
      const current = state.jobs[jobId];
      if (current.state !== 'unknown' || current.leaseToken !== job.leaseToken) fail('JOB_CHANGED');
      current.observedAdHash = hash(fresh.ad);
      if (current.observedAdHash === current.expectedAdHash) current.state = 'reconciled_locked';
      current.updatedAt = this.#stamp();
      // Do not release the account: a timed-out remote request could still arrive.
      // An installed runtime needs a separate reviewed quiescence procedure.
      audit(state, actor, companyId, 'UNKNOWN_READBACK', { jobId, observedHash: current.observedAdHash, state: current.state });
      return current;
    });
  }
  async metrikaReport(actor, companyId, input) {
    authorize(actor, companyId, 'ads.read');
    exact(input, ['counterId', 'range']);
    const counterId = id(input.counterId);
    const context = this.#store.read((state) => {
      const context = this.#context(state, companyId);
      if (!state.bindings[companyId].counterIds.includes(counterId)) fail('COUNTER_NOT_BOUND');
      return context;
    });
    let result;
    try {
      result = await this.#adapters.report(context, { counterId, range: input.range },
        (service, consume) => this.#reserve(actor, companyId, context, service, consume));
    } catch (error) { this.#recordAccessFailure(actor, companyId, context, error); }
    this.#reserve(actor, companyId, context, 'metrika', false);
    return result;
  }
  getCompanyView(actor, companyId) {
    authorize(actor, companyId, 'ads.read');
    return this.#store.read((state) => {
      const binding = state.bindings[companyId] || null;
      const connection = binding ? state.connections[binding.connectionId] : null;
      const bound = (row) => row.companyId === companyId && row.bindingVersion === binding?.version;
      const rows = Object.values(state.objects).filter(bound);
      const currentRead = connection?.active && rows.some((row) => row.connectionVersion === connection.version);
      const policy = state.policies[companyId] || clone(DEFAULT_POLICY);
      return { companyId, viewer: { id: actor.id, kind: actor.kind }, profile: state.profiles[companyId] || null, bindings: binding,
        connection: connection ? { id: connection.id, accountId: connection.accountId, principalId: connection.principalId,
          active: connection.active, verifiedAt: connection.verifiedAt } : null,
        capabilities: { connection: !connection ? 'unverified' : !connection.active ? 'revoked' : connection.verifiedAt ? 'verified' : 'unverified',
          transport: this.#adapters.available ? 'configured' : 'disabled', read: currentRead ? 'verified' : 'unverified',
          import: currentRead ? 'verified' : 'unverified', draftWrite: policy.mode === 'draft' ? 'configured' : 'disabled',
          attribution: 'unsupported', launch: 'unsupported', moderation: 'unsupported', payments: 'unsupported' },
        policy, objects: { campaigns: rows.filter((row) => row.kind === 'campaign').map((row) => row.data),
          ads: rows.filter((row) => row.kind === 'ad').map((row) => row.data) },
        proposals: Object.values(state.proposals).filter((row) => row.companyId === companyId),
        jobs: Object.values(state.jobs).filter((row) => row.companyId === companyId).map(({ leaseToken: _token, resource: _resource, ...safe }) => safe) };
    });
  }
}

module.exports = { YandexIntegration, FileStore };
