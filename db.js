/**
 * Camada de Banco de Dados Relacional (SQLite Backend API + Persistência Sincronizada)
 * Inicializado 100% ZERADO para cadastro real do zero.
 * Suporta Múltiplos Clientes de Contrato Fixo, Hierarquia (Admin, Técnico, Usuário), Temas e Fotos.
 */

const STORAGE_KEY = 'helpdesk_contrato_fixo_clean_v2';
const SESSION_KEY = 'helpdesk_active_session_v2';

const EMPTY_DATA = {
  contract: {
    clientName: '',
    cnpj: '',
    contractNumber: '',
    planType: 'Contrato Fixo Mensal',
    monthlyHoursQuota: 0,
    slaTargetPercent: 95,
    managerName: '',
    status: 'Ativo',
    adminUser: 'admin',
    adminPassword: 'admin123',
    companyName: 'ServiceDesk Pro',
    companyLogo: '',
    loginSubtitle: 'Portal de Chamados Técnicos & Controle de SLA',
    supportContact: '',
    adminAvatar: '',
    themeColor: 'indigo'
  },
  cloudConfig: {
    provider: 'sqlite', // 'sqlite' | 'supabase' | 'rest_postgres'
    endpointUrl: '',
    apiKey: '',
    autoSync: true,
    lastSync: null
  },
  clients: [],
  users: [],
  problemTypes: [],
  tickets: [],
  solutions: []
};

class DatabaseService {
  constructor() {
    // Limpa chave antiga que continha dados de demonstração
    localStorage.removeItem('helpdesk_contrato_fixo_v1');
    this.state = this.loadLocalCache();
    if (!Array.isArray(this.state.clients)) {
      this.state.clients = [];
    }
    if (!Array.isArray(this.state.solutions)) {
      this.state.solutions = [];
    }
    this.sqliteConnected = false;
    this.lastStateSignature = this.computeStateSignature(this.state);
    this.onRealtimeUpdateCallback = null;

    // Canal de comunicação instantânea entre abas do mesmo navegador
    try {
      this.broadcastChannel = new BroadcastChannel('servicedesk_realtime_sync');
      this.broadcastChannel.onmessage = (event) => {
        if (event.data && event.data.type === 'STATE_MUTATED') {
          this.syncFromServer();
        }
      };
    } catch (_) {
      this.broadcastChannel = null;
    }
  }

  computeStateSignature(st) {
    if (!st) return '';
    const ticketsPart = (st.tickets || []).map((t) => [
      t.id,
      t.status,
      t.technician,
      t.hoursSpent,
      t.problemFound || '',
      t.servicePerformed || '',
      t.priority,
      t.slaHours,
      t.title,
      (t.notes || []).length
    ]);
    const solutionsPart = (st.solutions || []).map((s) => [
      s.id,
      s.title,
      (s.attachments || []).length
    ]);
    const usersPart = (st.users || []).map((u) => [u.id, u.name, u.isBlocked, u.accessRole, u.clientId]);
    const clientsPart = (st.clients || []).map((c) => [c.id, c.name, c.monthlyHoursQuota, c.status]);
    return JSON.stringify({ ticketsPart, solutionsPart, usersPart, clientsPart });
  }

  diffTicketChanges(oldTickets, newTickets) {
    const events = [];
    const oldMap = new Map((oldTickets || []).map((t) => [t.id, t]));

    for (const next of newTickets || []) {
      const prev = oldMap.get(next.id);
      if (!prev) {
        events.push({ type: 'NEW_TICKET', ticket: next });
        continue;
      }
      if (prev.technician !== next.technician) {
        events.push({
          type: 'ASSIGNED_TECH',
          ticket: next,
          previousTechnician: prev.technician,
          newTechnician: next.technician
        });
      }
      if (prev.status !== 'Resolvido' && next.status === 'Resolvido') {
        events.push({
          type: 'TICKET_FINALIZED',
          ticket: next
        });
      } else if (prev.status !== next.status) {
        events.push({
          type: 'STATUS_CHANGED',
          ticket: next,
          previousStatus: prev.status,
          newStatus: next.status
        });
      }
      const prevNotesLen = (prev.notes || []).length;
      const nextNotesLen = (next.notes || []).length;
      if (nextNotesLen > prevNotesLen) {
        const lastNote = next.notes[nextNotesLen - 1];
        events.push({
          type: 'NEW_NOTE',
          ticket: next,
          note: lastNote
        });
      }
    }
    return events;
  }

  loadLocalCache() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const initial = JSON.parse(JSON.stringify(EMPTY_DATA));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
        return initial;
      }
      return JSON.parse(raw);
    } catch (e) {
      return JSON.parse(JSON.stringify(EMPTY_DATA));
    }
  }

  saveLocalCache(broadcast = true) {
    this.lastStateSignature = this.computeStateSignature(this.state);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (_) {}
    if (broadcast && this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({ type: 'STATE_MUTATED', ts: Date.now() });
      } catch (_) {}
    }
  }

  async initFromServer() {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (res.ok) {
        const serverState = await res.json();
        this.state = {
          ...this.state,
          contract: { ...this.state.contract, ...serverState.contract },
          clients: serverState.clients || [],
          users: serverState.users || [],
          problemTypes: serverState.problemTypes || [],
          tickets: serverState.tickets || [],
          solutions: serverState.solutions || []
        };
        this.sqliteConnected = true;
        this.saveLocalCache(false);
        return true;
      }
    } catch (_) {
      this.sqliteConnected = false;
    }
    return false;
  }

  async syncFromServer() {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (!res.ok) return { changed: false, events: [] };
      const serverState = await res.json();
      this.sqliteConnected = true;

      const nextSig = this.computeStateSignature(serverState);
      if (nextSig === this.lastStateSignature) {
        return { changed: false, events: [] };
      }

      const oldTickets = this.state.tickets || [];
      const newTickets = serverState.tickets || [];
      const events = this.diffTicketChanges(oldTickets, newTickets);

      this.state = {
        ...this.state,
        contract: { ...this.state.contract, ...serverState.contract },
        clients: serverState.clients || [],
        users: serverState.users || [],
        problemTypes: serverState.problemTypes || [],
        tickets: newTickets,
        solutions: serverState.solutions || []
      };
      this.saveLocalCache(false);

      if (typeof this.onRealtimeUpdateCallback === 'function') {
        this.onRealtimeUpdateCallback(events);
      }
      return { changed: true, events };
    } catch (_) {
      // Fallback para sincronização via localStorage quando offline
      const cached = this.loadLocalCache();
      const nextSig = this.computeStateSignature(cached);
      if (nextSig !== this.lastStateSignature) {
        const events = this.diffTicketChanges(this.state.tickets || [], cached.tickets || []);
        this.state = cached;
        this.lastStateSignature = nextSig;
        if (typeof this.onRealtimeUpdateCallback === 'function') {
          this.onRealtimeUpdateCallback(events);
        }
        return { changed: true, events };
      }
      return { changed: false, events: [] };
    }
  }

  // --- AUTENTICAÇÃO E SESSÃO (ADMIN vs TÉCNICO vs USUÁRIO DO CLIENTE) ---
  getSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  setSession(sessionObj) {
    if (!sessionObj) {
      sessionStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(SESSION_KEY);
      return;
    }
    const serialized = JSON.stringify(sessionObj);
    sessionStorage.setItem(SESSION_KEY, serialized);
    localStorage.setItem(SESSION_KEY, serialized);
  }

  async login(identifier, password) {
    const cleanId = (identifier || '').trim();
    const cleanPass = (password || '').trim();

    if (this.sqliteConnected) {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: cleanId, password: cleanPass })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Falha na autenticação.');
      }
      this.setSession(data.session);
      return data.session;
    }

    // Fallback caso aberto direto via file://
    const adminUser = (this.state.contract.adminUser || 'admin').trim();
    const adminPass = (this.state.contract.adminPassword || 'admin123').trim();
    if (
      [adminUser.toLowerCase(), 'admin', 'admin@admin.com'].includes(cleanId.toLowerCase()) &&
      [adminPass, 'admin123'].includes(cleanPass)
    ) {
      const session = {
        role: 'ADMIN',
        name: 'Administrador Geral',
        email: adminUser,
        department: 'Diretoria / Gestão TI',
        userId: null,
        clientId: '',
        mustChangePassword: false,
        avatar: this.state.contract.adminAvatar || '',
        themeColor: this.state.contract.themeColor || 'indigo'
      };
      this.setSession(session);
      return session;
    }

    const foundUser = this.state.users.find(
      (u) =>
        (u.email.toLowerCase() === cleanId.toLowerCase() ||
          (u.name || '').toLowerCase() === cleanId.toLowerCase()) &&
        (u.password || '123456') === cleanPass
    );
    if (foundUser) {
      if (foundUser.isBlocked) {
        throw new Error('Acesso bloqueado pelo Administrador. Entre em contato com a gestão do contrato.');
      }
      const userAccessRole = ['ADMIN', 'TECH', 'USER'].includes(foundUser.accessRole)
        ? foundUser.accessRole
        : 'USER';
      const session = {
        role: userAccessRole,
        userId: foundUser.id,
        clientId: foundUser.clientId || '',
        name: foundUser.name,
        email: foundUser.email,
        phone: foundUser.phone || '',
        department: foundUser.department,
        jobRole: foundUser.role,
        isVip: Boolean(foundUser.isVip),
        mustChangePassword: foundUser.mustChangePassword !== undefined ? Boolean(foundUser.mustChangePassword) : true,
        avatar: foundUser.avatar || '',
        themeColor: foundUser.themeColor || this.state.contract.themeColor || 'indigo'
      };
      this.setSession(session);
      return session;
    }

    throw new Error('E-mail/login ou senha inválidos.');
  }

  async resetAllPasswordsToDefault() {
    if (this.sqliteConnected) {
      const res = await fetch('/api/auth/reset-passwords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (res.ok) {
        const out = await res.json();
        this.state = { ...this.state, ...out.state };
        this.saveLocalCache();
        return this.state;
      }
    }
    this.state.contract.adminUser = 'admin';
    this.state.contract.adminPassword = 'admin123';
    this.state.users = (this.state.users || []).map((u) => ({
      ...u,
      password: '123456',
      isBlocked: false,
      mustChangePassword: true
    }));
    this.saveLocalCache();
    return this.state;
  }

  logout() {
    this.setSession(null);
  }

  // --- ZERAR BANCO DE DADOS ---
  async clearAllDatabase() {
    if (this.sqliteConnected) {
      const res = await fetch('/api/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (res.ok) {
        const data = await res.json();
        this.state = { ...this.state, ...data.state };
        this.saveLocalCache();
        return this.state;
      }
    }
    this.state = JSON.parse(JSON.stringify(EMPTY_DATA));
    this.saveLocalCache();
    return this.state;
  }

  // --- CONTRATO GERAL / BRANDING & CLOUD ---
  getContract() {
    return this.state.contract;
  }

  async updateContract(data) {
    if (this.sqliteConnected) {
      const res = await fetch('/api/contract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (res.ok) {
        const out = await res.json();
        this.state = { ...this.state, ...out.state };
        this.saveLocalCache();
        return this.state.contract;
      }
    }
    this.state.contract = { ...this.state.contract, ...data };
    this.saveLocalCache();
    return this.state.contract;
  }

  getCloudConfig() {
    return this.state.cloudConfig;
  }

  updateCloudConfig(config) {
    this.state.cloudConfig = { ...this.state.cloudConfig, ...config };
    this.saveLocalCache();
    return this.state.cloudConfig;
  }

  // --- MÚLTIPLOS CLIENTES DE CONTRATO FIXO ---
  getClients() {
    return [...(this.state.clients || [])];
  }

  async addClient(clientData) {
    const payload = {
      name: (clientData.name || '').trim(),
      cnpj: (clientData.cnpj || '').trim(),
      contractNumber: (clientData.contractNumber || '').trim(),
      planType: (clientData.planType || 'Contrato Fixo Mensal').trim(),
      monthlyHoursQuota: Number(clientData.monthlyHoursQuota) || 0,
      slaTargetPercent: Number(clientData.slaTargetPercent) || 95,
      managerName: (clientData.managerName || '').trim(),
      phone: (clientData.phone || '').trim(),
      status: clientData.status || 'Ativo'
    };

    if (!payload.name) {
      throw new Error('Informe a Razão Social / Nome da Empresa Cliente.');
    }

    if (this.sqliteConnected) {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const out = await res.json();
      if (!res.ok || !out.ok) {
        throw new Error(out.error || 'Erro ao cadastrar cliente de contrato.');
      }
      this.state = { ...this.state, ...out.state };
      this.saveLocalCache();
      return this.state.clients.find((c) => c.id === out.clientId) || this.state.clients[0];
    }

    const newClient = {
      id: 'cli-' + Date.now().toString(36),
      ...payload,
      createdAt: new Date().toISOString()
    };
    this.state.clients.unshift(newClient);
    if (!this.state.contract.clientName) {
      this.state.contract.clientName = newClient.name;
      this.state.contract.cnpj = newClient.cnpj;
      this.state.contract.contractNumber = newClient.contractNumber;
      this.state.contract.monthlyHoursQuota = newClient.monthlyHoursQuota;
      this.state.contract.slaTargetPercent = newClient.slaTargetPercent;
      this.state.contract.managerName = newClient.managerName;
    }
    this.saveLocalCache();
    return newClient;
  }

  async updateClient(id, updates) {
    if (this.sqliteConnected) {
      const res = await fetch('/api/clients/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...updates })
      });
      const out = await res.json();
      if (!res.ok || !out.ok) {
        throw new Error(out.error || 'Erro ao atualizar cliente de contrato.');
      }
      this.state = { ...this.state, ...out.state };
      this.saveLocalCache();
      return this.state.clients.find((c) => c.id === id);
    }

    const idx = this.state.clients.findIndex((c) => c.id === id);
    if (idx === -1) throw new Error('Cliente não encontrado.');
    this.state.clients[idx] = { ...this.state.clients[idx], ...updates };
    this.saveLocalCache();
    return this.state.clients[idx];
  }

  async deleteClient(id) {
    if (this.sqliteConnected) {
      const res = await fetch(`/api/clients/${id}`, { method: 'DELETE' });
      if (res.ok) {
        const out = await res.json();
        this.state = { ...this.state, ...out.state };
        this.saveLocalCache();
        return;
      }
    }
    this.state.clients = this.state.clients.filter((c) => c.id !== id);
    this.state.users.forEach((u) => {
      if (u.clientId === id) u.clientId = '';
    });
    this.state.tickets.forEach((t) => {
      if (t.clientId === id) t.clientId = '';
    });
    this.saveLocalCache();
  }

  // --- USUÁRIOS & PERFIL ---
  getUsers() {
    return [...this.state.users];
  }

  async addUser(user) {
    const accessRole = ['ADMIN', 'TECH', 'USER'].includes(user.accessRole) ? user.accessRole : 'USER';
    const payload = {
      name: user.name.trim(),
      email: user.email.trim().toLowerCase(),
      password: (user.password || '123456').trim(),
      phone: user.phone?.trim() || '',
      department: user.department.trim(),
      role: user.role?.trim() || '',
      accessRole,
      clientId: user.clientId || '',
      isVip: Boolean(user.isVip),
      isBlocked: Boolean(user.isBlocked),
      mustChangePassword: user.mustChangePassword !== undefined ? Boolean(user.mustChangePassword) : true,
      avatar: user.avatar || '',
      themeColor: user.themeColor || 'indigo'
    };

    if (this.sqliteConnected) {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const out = await res.json();
      if (!res.ok || !out.ok) {
        throw new Error(out.error || 'Erro ao salvar usuário no banco SQLite.');
      }
      this.state = { ...this.state, ...out.state };
      this.saveLocalCache();
      return this.state.users.find((u) => u.id === out.userId) || this.state.users[0];
    }

    if (this.state.users.some((u) => u.email.toLowerCase() === payload.email)) {
      throw new Error('Já existe um usuário cadastrado com este e-mail.');
    }

    const newUser = {
      id: 'usr-' + Date.now().toString(36),
      ...payload,
      createdAt: new Date().toISOString()
    };
    this.state.users.unshift(newUser);
    this.saveLocalCache();
    return newUser;
  }

  async updateUser(id, updates) {
    if (this.sqliteConnected) {
      const res = await fetch('/api/users/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...updates })
      });
      const out = await res.json();
      if (!res.ok || !out.ok) {
        throw new Error(out.error || 'Erro ao atualizar usuário.');
      }
      this.state = { ...this.state, ...out.state };
      this.saveLocalCache();
      return this.state.users.find((u) => u.id === id);
    }

    const idx = this.state.users.findIndex((u) => u.id === id);
    if (idx === -1) throw new Error('Usuário não encontrado.');
    this.state.users[idx] = { ...this.state.users[idx], ...updates };
    this.saveLocalCache();
    return this.state.users[idx];
  }

  async updateMyProfile(payload) {
    if (this.sqliteConnected) {
      const res = await fetch('/api/profile/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const out = await res.json();
      if (!res.ok || !out.ok) {
        throw new Error(out.error || 'Erro ao atualizar configurações do perfil.');
      }
      this.state = { ...this.state, ...out.state };
      this.saveLocalCache();
    } else {
      if (!payload.userId) {
        if (payload.newPassword) this.state.contract.adminPassword = payload.newPassword;
        if (payload.avatar !== undefined) this.state.contract.adminAvatar = payload.avatar;
        if (payload.themeColor) this.state.contract.themeColor = payload.themeColor;
      } else {
        const idx = this.state.users.findIndex((u) => u.id === payload.userId);
        if (idx !== -1) {
          if (payload.newPassword) {
            this.state.users[idx].password = payload.newPassword;
            this.state.users[idx].mustChangePassword = false;
          }
          if (payload.avatar !== undefined) this.state.users[idx].avatar = payload.avatar;
          if (payload.themeColor) this.state.users[idx].themeColor = payload.themeColor;
          if (payload.name) this.state.users[idx].name = payload.name;
          if (payload.phone !== undefined) this.state.users[idx].phone = payload.phone;
        }
      }
      this.saveLocalCache();
    }

    // Sincroniza sessão ativa
    const session = this.getSession();
    if (session) {
      if (payload.name) session.name = payload.name;
      if (payload.phone !== undefined) session.phone = payload.phone;
      if (payload.avatar !== undefined) session.avatar = payload.avatar;
      if (payload.themeColor) session.themeColor = payload.themeColor;
      if (payload.newPassword) session.mustChangePassword = false;
      this.setSession(session);
    }
    return session;
  }

  async deleteUser(id) {
    if (this.sqliteConnected) {
      const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
      if (res.ok) {
        const out = await res.json();
        this.state = { ...this.state, ...out.state };
        this.saveLocalCache();
        return;
      }
    }
    this.state.users = this.state.users.filter((u) => u.id !== id);
    this.saveLocalCache();
  }

  // --- TIPOS DE PROBLEMA & SLA ---
  getProblemTypes() {
    return [...this.state.problemTypes];
  }

  async addProblemType(problem) {
    const payload = {
      name: problem.name.trim(),
      category: problem.category.trim(),
      defaultSlaHours: Number(problem.defaultSlaHours) || 4,
      priority: problem.priority || 'Média',
      description: problem.description?.trim() || ''
    };

    if (this.sqliteConnected) {
      const res = await fetch('/api/problems', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const out = await res.json();
        this.state = { ...this.state, ...out.state };
        this.saveLocalCache();
        return this.state.problemTypes.find((p) => p.id === out.problemId);
      }
    }

    const newProblem = {
      id: 'prb-' + Date.now().toString(36),
      ...payload
    };
    this.state.problemTypes.push(newProblem);
    this.saveLocalCache();
    return newProblem;
  }

  async deleteProblemType(id) {
    if (this.sqliteConnected) {
      const res = await fetch(`/api/problems/${id}`, { method: 'DELETE' });
      if (res.ok) {
        const out = await res.json();
        this.state = { ...this.state, ...out.state };
        this.saveLocalCache();
        return;
      }
    }
    this.state.problemTypes = this.state.problemTypes.filter((p) => p.id !== id);
    this.saveLocalCache();
  }

  // --- CHAMADOS ---
  getTickets() {
    return [...this.state.tickets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  async addTicket(ticketData) {
    const userObj = this.state.users.find((u) => u.id === ticketData.userId);
    const resolvedClientId = ticketData.clientId || userObj?.clientId || '';

    const payload = {
      title: ticketData.title.trim(),
      description: ticketData.description.trim(),
      userId: ticketData.userId,
      clientId: resolvedClientId,
      problemTypeId: ticketData.problemTypeId,
      slaHours: Number(ticketData.slaHours) || 4,
      priority: ticketData.priority || 'Média',
      technician: ticketData.technician?.trim() || 'Aguardando Direcionamento (Admin)'
    };

    if (this.sqliteConnected) {
      const res = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const out = await res.json();
        this.state = { ...this.state, ...out.state };
        this.saveLocalCache();
        return this.state.tickets.find((t) => t.id === out.ticketId) || this.state.tickets[0];
      }
    }

    const now = new Date();
    const dueAt = new Date(now.getTime() + payload.slaHours * 3600000);
    const nextNum = 1001 + this.state.tickets.length;

    const newTicket = {
      id: `CH-${nextNum}`,
      ...payload,
      status: 'Aberto',
      hoursSpent: 0,
      problemFound: '',
      servicePerformed: '',
      createdAt: now.toISOString(),
      dueAt: dueAt.toISOString(),
      resolvedAt: null,
      notes: []
    };

    this.state.tickets.unshift(newTicket);
    this.saveLocalCache();
    return newTicket;
  }

  async updateTicket(id, updates) {
    if (this.sqliteConnected) {
      const res = await fetch('/api/tickets/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...updates })
      });
      if (res.ok) {
        const out = await res.json();
        this.state = { ...this.state, ...out.state };
        this.saveLocalCache();
        return this.state.tickets.find((t) => t.id === id);
      }
    }

    const idx = this.state.tickets.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    const current = this.state.tickets[idx];
    const updated = { ...current, ...updates };

    if (updates.slaHours !== undefined && Number(updates.slaHours) !== Number(current.slaHours)) {
      const createdDate = new Date(current.createdAt);
      updated.dueAt = new Date(createdDate.getTime() + Number(updates.slaHours) * 3600000).toISOString();
    }

    if (updates.status === 'Resolvido' && current.status !== 'Resolvido') {
      updated.resolvedAt = new Date().toISOString();
    } else if (updates.status && updates.status !== 'Resolvido') {
      updated.resolvedAt = null;
    }

    this.state.tickets[idx] = updated;

    // Alimenta automaticamente o Banco de Soluções quando o chamado é finalizado com Problema Encontrado / Serviço Realizado
    if (updated.status === 'Resolvido' && (updated.problemFound || updated.servicePerformed)) {
      if (!Array.isArray(this.state.solutions)) this.state.solutions = [];
      const existingIdx = this.state.solutions.findIndex((s) => s.ticketId === updated.id);
      const prevAtts = existingIdx >= 0 && Array.isArray(this.state.solutions[existingIdx].attachments)
        ? [...this.state.solutions[existingIdx].attachments]
        : [];
      const incomingAtts = Array.isArray(updates.solutionAttachments) ? updates.solutionAttachments : [];
      const mergedAtts = [...prevAtts, ...incomingAtts];

      const solRecord = {
        id: existingIdx >= 0 ? this.state.solutions[existingIdx].id : 'sol-' + Date.now().toString(36),
        ticketId: updated.id,
        problemTypeId: updated.problemTypeId || '',
        title: updated.title,
        problemFound: updated.problemFound || 'Não especificado',
        servicePerformed: updated.servicePerformed || 'Não especificado',
        technician: updated.technician || 'Equipe Técnica',
        hoursSpent: Number(updated.hoursSpent) || 0,
        attachments: mergedAtts,
        createdAt: updated.resolvedAt || new Date().toISOString()
      };
      if (existingIdx >= 0) {
        this.state.solutions[existingIdx] = solRecord;
      } else {
        this.state.solutions.unshift(solRecord);
      }
    }

    this.saveLocalCache();
    return updated;
  }

  // --- BANCO DE SOLUÇÕES (BASEADO NOS ATENDIMENTOS REALIZADOS + DOCUMENTAÇÃO PDF) ---
  getSolutions() {
    const list = Array.isArray(this.state.solutions)
      ? this.state.solutions.map((s) => ({
          ...s,
          attachments: Array.isArray(s.attachments) ? s.attachments : []
        }))
      : [];
    const byTicket = new Set(list.map((s) => s.ticketId).filter(Boolean));
    // Garante que qualquer chamado Resolvido com problema encontrado / serviço realizado apareça no Banco de Soluções
    (this.state.tickets || []).forEach((t) => {
      if (t.status === 'Resolvido' && (t.problemFound || t.servicePerformed) && !byTicket.has(t.id)) {
        list.push({
          id: 'sol-auto-' + t.id,
          ticketId: t.id,
          problemTypeId: t.problemTypeId || '',
          title: t.title,
          problemFound: t.problemFound || 'Não especificado',
          servicePerformed: t.servicePerformed || 'Não especificado',
          technician: t.technician || 'Equipe Técnica',
          hoursSpent: Number(t.hoursSpent) || 0,
          attachments: [],
          createdAt: t.resolvedAt || t.createdAt
        });
      }
    });
    return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  async addSolution(solData) {
    const payload = {
      id: solData.id || '',
      ticketId: (solData.ticketId || '').trim(),
      problemTypeId: (solData.problemTypeId || '').trim(),
      title: (solData.title || '').trim(),
      problemFound: (solData.problemFound || '').trim(),
      servicePerformed: (solData.servicePerformed || '').trim(),
      technician: (solData.technician || 'Equipe Técnica').trim(),
      hoursSpent: Number(solData.hoursSpent) || 0,
      attachments: Array.isArray(solData.attachments) ? solData.attachments : []
    };

    if (!payload.title || !payload.problemFound || !payload.servicePerformed) {
      throw new Error('Preencha o Título, o Problema Encontrado e o Serviço Realizado.');
    }

    if (this.sqliteConnected) {
      const res = await fetch('/api/solutions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const out = await res.json();
        this.state = { ...this.state, ...out.state };
        this.saveLocalCache();
        return this.state.solutions.find((s) => s.id === out.solutionId) || this.state.solutions[0];
      }
    }

    if (!Array.isArray(this.state.solutions)) this.state.solutions = [];
    const newSol = {
      ...payload,
      id: payload.id || 'sol-' + Date.now().toString(36),
      createdAt: new Date().toISOString()
    };
    this.state.solutions.unshift(newSol);
    this.saveLocalCache();
    return newSol;
  }

  async addSolutionAttachment(solutionId, attachment) {
    if (this.sqliteConnected) {
      const res = await fetch('/api/solutions/attachments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          solutionId,
          action: 'add',
          attachment
        })
      });
      if (res.ok) {
        const out = await res.json();
        this.state = { ...this.state, ...out.state };
        this.saveLocalCache();
        return;
      }
    }

    if (!Array.isArray(this.state.solutions)) this.state.solutions = [];
    const idx = this.state.solutions.findIndex((s) => s.id === solutionId);
    if (idx >= 0) {
      if (!Array.isArray(this.state.solutions[idx].attachments)) {
        this.state.solutions[idx].attachments = [];
      }
      this.state.solutions[idx].attachments.push(attachment);
      this.saveLocalCache();
    }
  }

  async removeSolutionAttachment(solutionId, attachmentId) {
    if (this.sqliteConnected) {
      const res = await fetch('/api/solutions/attachments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          solutionId,
          action: 'remove',
          attachmentId
        })
      });
      if (res.ok) {
        const out = await res.json();
        this.state = { ...this.state, ...out.state };
        this.saveLocalCache();
        return;
      }
    }

    if (!Array.isArray(this.state.solutions)) return;
    const idx = this.state.solutions.findIndex((s) => s.id === solutionId);
    if (idx >= 0 && Array.isArray(this.state.solutions[idx].attachments)) {
      this.state.solutions[idx].attachments = this.state.solutions[idx].attachments.filter(
        (a) => a.id !== attachmentId
      );
      this.saveLocalCache();
    }
  }

  async deleteSolution(id) {
    if (this.sqliteConnected) {
      const res = await fetch(`/api/solutions/${id}`, { method: 'DELETE' });
      if (res.ok) {
        const out = await res.json();
        this.state = { ...this.state, ...out.state };
        this.saveLocalCache();
        return;
      }
    }
    this.state.solutions = (this.state.solutions || []).filter((s) => s.id !== id);
    this.saveLocalCache();
  }

  async addTicketNote(ticketId, author, text) {
    if (this.sqliteConnected) {
      const res = await fetch('/api/tickets/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId, author, text })
      });
      if (res.ok) {
        const out = await res.json();
        this.state = { ...this.state, ...out.state };
        this.saveLocalCache();
        return;
      }
    }

    const ticket = this.state.tickets.find((t) => t.id === ticketId);
    if (!ticket) return null;
    const note = {
      id: 'nt-' + Date.now().toString(36),
      author: author || 'Usuário',
      text: text.trim(),
      createdAt: new Date().toISOString()
    };
    ticket.notes.push(note);
    this.saveLocalCache();
    return note;
  }

  async deleteTicket(id) {
    if (this.sqliteConnected) {
      const res = await fetch(`/api/tickets/${id}`, { method: 'DELETE' });
      if (res.ok) {
        const out = await res.json();
        this.state = { ...this.state, ...out.state };
        this.saveLocalCache();
        return;
      }
    }
    this.state.tickets = this.state.tickets.filter((t) => t.id !== id);
    this.saveLocalCache();
  }

  getPostgresSchemaSQL() {
    return `-- Schema SQL pronto para Supabase / PostgreSQL (Multi-Clientes + Hierarquia + Banco de Soluções + PDFs)
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cnpj TEXT,
  contract_number TEXT,
  plan_type TEXT DEFAULT 'Contrato Fixo Mensal',
  monthly_hours_quota NUMERIC DEFAULT 0,
  sla_target_percent NUMERIC DEFAULT 95,
  manager_name TEXT,
  phone TEXT,
  status TEXT DEFAULT 'Ativo',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  phone TEXT,
  department TEXT NOT NULL,
  role TEXT,
  access_role TEXT NOT NULL DEFAULT 'USER',
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  is_vip BOOLEAN DEFAULT FALSE,
  is_blocked BOOLEAN DEFAULT FALSE,
  must_change_password BOOLEAN DEFAULT TRUE,
  avatar TEXT,
  theme_color TEXT DEFAULT 'indigo',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE problem_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  default_sla_hours NUMERIC NOT NULL DEFAULT 4,
  priority TEXT NOT NULL DEFAULT 'Média',
  description TEXT
);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  problem_type_id TEXT REFERENCES problem_types(id) ON DELETE RESTRICT,
  sla_hours NUMERIC NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Aberto',
  technician TEXT,
  hours_spent NUMERIC DEFAULT 0,
  problem_found TEXT DEFAULT '',
  service_performed TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  due_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  notes JSONB DEFAULT '[]'::jsonb
);

CREATE TABLE solutions (
  id TEXT PRIMARY KEY,
  ticket_id TEXT,
  problem_type_id TEXT REFERENCES problem_types(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  problem_found TEXT NOT NULL,
  service_performed TEXT NOT NULL,
  technician TEXT,
  hours_spent NUMERIC DEFAULT 0,
  attachments JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);`;
  }
}

window.db = new DatabaseService();
