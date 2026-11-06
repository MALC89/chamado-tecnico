/**
 * Lógica Principal da Aplicação — ServiceDesk Pro (Banco SQLite + Controle de Acesso Admin/Usuário)
 */

let currentTab = 'tickets';
let activeTicketId = null;

document.addEventListener('DOMContentLoaded', async () => {
  await window.db.initFromServer();
  window.db.onRealtimeUpdateCallback = handleRealtimeServerUpdate;
  checkAuthAndRender();

  // Sincronização automática em tempo real a cada 2.5 segundos (sem precisar atualizar a página manualmente)
  setInterval(() => {
    if (window.db.getSession()) {
      window.db.syncFromServer();
    }
  }, 2500);

  // Sincroniza imediatamente sempre que o usuário alternar para a aba do navegador
  window.addEventListener('focus', () => {
    if (window.db.getSession()) {
      window.db.syncFromServer();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && window.db.getSession()) {
      window.db.syncFromServer();
    }
  });

  // Atualiza cronômetros de SLA em tempo real a cada 20 segundos
  setInterval(() => {
    if (window.db.getSession()) {
      renderTickets();
      updateHeaderAndSidebarStats();
    }
  }, 20000);

  const slaInput = document.getElementById('ticket-sla');
  if (slaInput) {
    slaInput.addEventListener('input', updateDuePreview);
  }
});

/**
 * Chamado automaticamente quando outro usuário (Admin, Técnico ou Solicitante)
 * cria, direciona, interage ou finaliza um chamado no servidor.
 */
function handleRealtimeServerUpdate(events = []) {
  const session = window.db.getSession();
  if (!session) return;

  const role = session.role || 'USER';
  const myName = (session.name || '').toLowerCase().trim();
  const scopedIds = new Set(
    getScopedTicketsForSession(session, window.db.getTickets()).map((t) => t.id)
  );

  // Atualiza listagens, contadores, relatórios e banco de soluções automaticamente
  updateHeaderAndSidebarStats();
  populateFilterDropdowns();
  populateTechnicianDatalist();
  renderTickets();
  renderDashboard();
  renderSolutionsBank();
  if (role === 'ADMIN') {
    renderUsers();
    renderProblemTypes();
    renderClientsList();
  }

  // Se o modal de detalhes de um chamado estiver aberto na tela, atualiza os dados ao vivo sem fechar o modal
  if (activeTicketId) {
    refreshOpenDetailModalLive(activeTicketId);
  }

  if (window.lucide) {
    lucide.createIcons();
  }

  // Exibe notificações automáticas em tempo real conforme o perfil logado
  const finalizedIds = new Set(
    events.filter((e) => e.type === 'TICKET_FINALIZED').map((e) => e.ticket.id)
  );

  events.forEach((ev) => {
    const t = ev.ticket;
    if (!t) return;

    if (ev.type === 'NEW_TICKET') {
      if (role === 'ADMIN') {
        showToast(`🆕 Novo chamado recebido para triagem: ${t.id} — ${t.title}`);
      }
      return;
    }

    if (ev.type === 'ASSIGNED_TECH') {
      const assignedLower = (ev.newTechnician || '').toLowerCase().trim();
      const isAssignedToMe =
        role === 'TECH' &&
        ((myName && assignedLower.includes(myName)) || assignedLower === 'fila técnica geral');

      if (isAssignedToMe) {
        showToast(`🔔 Novo chamado recebido: ${t.id} — ${t.title} (Aguardando seu aceite para iniciar!)`);
      } else if (role === 'USER' && t.userId === session.userId) {
        showToast(`👨‍🔧 Seu chamado ${t.id} foi recebido pela equipe técnica (${ev.newTechnician})`, 'info');
      } else if (role === 'ADMIN') {
        showToast(`🔄 Chamado ${t.id} direcionado para: ${ev.newTechnician} (Status: Aberto)`, 'info');
      }
      return;
    }

    if (ev.type === 'TICKET_STARTED') {
      if (role === 'ADMIN' || scopedIds.has(t.id) || t.userId === session.userId) {
        showToast(`▶️ Atendimento iniciado no chamado ${t.id} por ${t.technician || 'Técnico'}!`);
      }
      return;
    }

    if (ev.type === 'TICKET_FINALIZED') {
      if (role === 'ADMIN' || scopedIds.has(t.id) || t.userId === session.userId) {
        showToast(
          `✅ Chamado ${t.id} (${t.title}) foi finalizado por ${t.technician || 'Técnico'}!`
        );
      }
      return;
    }

    if (ev.type === 'STATUS_CHANGED' && !finalizedIds.has(t.id)) {
      if (role === 'ADMIN' || scopedIds.has(t.id) || t.userId === session.userId) {
        showToast(`🔄 Status do chamado ${t.id} atualizado para: ${ev.newStatus}`, 'info');
      }
      return;
    }

    if (ev.type === 'NEW_NOTE' && !finalizedIds.has(t.id)) {
      if (role === 'ADMIN' || scopedIds.has(t.id) || t.userId === session.userId) {
        showToast(`💬 Nova interação no chamado ${t.id} por ${ev.note?.author || 'Equipe'}`, 'info');
      }
    }
  });
}

/**
 * Atualiza o modal de detalhes aberto em tempo real sem apagar o que o usuário estiver digitando
 */
function refreshOpenDetailModalLive(ticketId) {
  const ticket = window.db.getTickets().find((t) => t.id === ticketId);
  if (!ticket) {
    closeDetailModal();
    return;
  }

  const sla = evaluateTicketSla(ticket);
  const slaBadgeEl = document.getElementById('detail-sla-badge');
  if (slaBadgeEl) {
    slaBadgeEl.innerHTML = `
      <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${sla.badgeClass}">
        ${sla.label} (SLA: ${ticket.slaHours}h)
      </span>
    `;
  }

  const readonlyBox = document.getElementById('detail-resolution-readonly-box');
  const roProb = document.getElementById('detail-readonly-problem-found');
  const roServ = document.getElementById('detail-readonly-service-performed');
  if (readonlyBox && roProb && roServ) {
    if (ticket.problemFound || ticket.servicePerformed) {
      readonlyBox.classList.remove('hidden');
      roProb.textContent = ticket.problemFound || 'Não informado.';
      roServ.textContent = ticket.servicePerformed || 'Não informado.';
    } else {
      readonlyBox.classList.add('hidden');
    }
  }

  updateDetailModalTimelineAndAccept(ticket);

  const activeEl = document.activeElement;
  const statusEl = document.getElementById('detail-status');
  const techEl = document.getElementById('detail-tech');
  const hoursEl = document.getElementById('detail-hours');
  const probFoundEl = document.getElementById('detail-problem-found');
  const servPerfEl = document.getElementById('detail-service-performed');

  if (statusEl && activeEl !== statusEl) statusEl.value = ticket.status;
  if (techEl && activeEl !== techEl) techEl.value = ticket.technician;
  if (hoursEl && activeEl !== hoursEl) hoursEl.value = ticket.hoursSpent || 0;
  if (probFoundEl && activeEl !== probFoundEl && !probFoundEl.value) {
    probFoundEl.value = ticket.problemFound || '';
  }
  if (servPerfEl && activeEl !== servPerfEl && !servPerfEl.value) {
    servPerfEl.value = ticket.servicePerformed || '';
  }

  renderTicketNotes(ticket);
}

// ==========================================
// AUTENTICAÇÃO E PERMISSÕES (ADMIN vs USUÁRIO)
// ==========================================
function checkAuthAndRender() {
  applyCompanyBranding();
  const session = window.db.getSession();
  const loginScreen = document.getElementById('login-screen');

  if (!session) {
    loginScreen.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
    return;
  }

  loginScreen.classList.add('hidden');
  applyRolePermissions(session);
  refreshAllViews();
}

function applyCompanyBranding() {
  const c = window.db.getContract() || {};
  const companyName = c.companyName || 'ServiceDesk Pro';
  const subtitle = c.loginSubtitle || 'Portal de Chamados Técnicos & Controle de SLA';
  const logo = c.companyLogo || '';
  const support = c.supportContact || 'Acesso restrito a colaboradores autorizados e equipe técnica.';

  // Atualiza textos da Tela de Login e Sidebar
  const loginTitle = document.getElementById('login-company-name');
  if (loginTitle) loginTitle.textContent = companyName;

  const loginSub = document.getElementById('login-company-subtitle');
  if (loginSub) loginSub.textContent = subtitle;

  const sidebarTitle = document.getElementById('sidebar-company-name');
  if (sidebarTitle) sidebarTitle.textContent = companyName;

  const loginFooter = document.getElementById('login-support-footer');
  if (loginFooter) loginFooter.textContent = support;

  // Pílula do cliente na tela de login
  const clientPill = document.getElementById('login-client-pill');
  const clientPillText = document.getElementById('login-client-pill-text');
  if (clientPill && clientPillText) {
    if (c.clientName) {
      clientPillText.textContent = c.clientName;
      clientPill.classList.remove('hidden');
    } else {
      clientPill.classList.add('hidden');
    }
  }

  // Atualiza Imagens de Logo (Login + Sidebar)
  const loginImg = document.getElementById('login-logo-img');
  const loginFallback = document.getElementById('login-logo-fallback');
  const sideImg = document.getElementById('sidebar-logo-img');
  const sideFallback = document.getElementById('sidebar-logo-fallback');

  if (logo) {
    if (loginImg) {
      loginImg.src = logo;
      loginImg.classList.remove('hidden');
    }
    if (loginFallback) loginFallback.classList.add('hidden');

    if (sideImg) {
      sideImg.src = logo;
      sideImg.classList.remove('hidden');
    }
    if (sideFallback) sideFallback.classList.add('hidden');
  } else {
    if (loginImg) loginImg.classList.add('hidden');
    if (loginFallback) loginFallback.classList.remove('hidden');
    if (sideImg) sideImg.classList.add('hidden');
    if (sideFallback) sideFallback.classList.remove('hidden');
  }
}

function toggleLoginPasswordVisibility() {
  const input = document.getElementById('login-password');
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
}

const THEME_LABELS = {
  indigo: 'Índigo Padrão',
  blue: 'Azul Oceano',
  emerald: 'Esmeralda',
  violet: 'Roxo Real',
  rose: 'Rubi / Carmim',
  amber: 'Laranja Âmbar',
  slate: 'Grafite Escuro'
};

function applyThemeColor(colorName) {
  const validColor = THEME_LABELS[colorName] ? colorName : 'indigo';
  document.documentElement.setAttribute('data-theme', validColor);

  const badge = document.getElementById('current-theme-badge');
  if (badge) {
    badge.textContent = `Tema Ativo: ${THEME_LABELS[validColor]}`;
  }

  document.querySelectorAll('.theme-color-btn').forEach((btn) => {
    const c = btn.getAttribute('data-color-btn');
    if (c === validColor) {
      btn.classList.add('border-indigo-600', 'bg-indigo-50/40', 'ring-2', 'ring-indigo-500/20');
      btn.classList.remove('border-slate-200');
    } else {
      btn.classList.remove('border-indigo-600', 'bg-indigo-50/40', 'ring-2', 'ring-indigo-500/20');
      btn.classList.add('border-slate-200');
    }
  });
}

function getInitials(name) {
  if (!name) return 'US';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function isTicketAwaitingAdminTriage(ticket) {
  const tech = (ticket?.technician || '').toLowerCase().trim();
  return (
    !tech ||
    tech === 'aguardando direcionamento (admin)' ||
    tech === 'aguardando atribuição' ||
    tech === 'não atribuído'
  );
}

/**
 * Retorna os chamados visíveis conforme a hierarquia do usuário logado:
 * - ADMIN: Vê 100% dos chamados (inclusive todos que chegam para o Admin direcionar ou atender)
 * - TECH: Vê os chamados direcionados pelo Admin para ele (ou liberados para a fila técnica) + chamados abertos por ele
 * - USER: Vê exclusivamente os chamados abertos por ele mesmo
 */
function getScopedTicketsForSession(session, allTickets) {
  if (!session) return [];
  if (session.role === 'ADMIN') {
    return allTickets;
  }
  if (session.role === 'TECH') {
    const techName = (session.name || '').toLowerCase().trim();
    return allTickets.filter((t) => {
      const assigned = (t.technician || '').toLowerCase().trim();
      const isDirectedToMe = techName && assigned.includes(techName);
      const isReleasedToPool = assigned === 'fila técnica geral';
      const openedByMe = session.userId && t.userId === session.userId;
      return isDirectedToMe || isReleasedToPool || openedByMe;
    });
  }
  // USER (Usuário Comum / Solicitante)
  return allTickets.filter((t) => t.userId === session.userId);
}

function isSessionForcedPasswordChange(session) {
  if (!session || !session.userId) return false;
  const userObj = window.db.getUsers().find((u) => u.id === session.userId);
  if (userObj) {
    return Boolean(userObj.mustChangePassword);
  }
  return Boolean(session.mustChangePassword);
}

function applyRolePermissions(session) {
  const role = session.role || 'USER'; // 'ADMIN' | 'TECH' | 'USER'
  const isAdmin = role === 'ADMIN';
  const isTech = role === 'TECH';

  // Aplica cor do tema do usuário ou do contrato
  const contract = window.db.getContract() || {};
  const userObj = session.userId ? window.db.getUsers().find((u) => u.id === session.userId) : null;
  const activeColor = userObj?.themeColor || session.themeColor || contract.themeColor || 'indigo';
  applyThemeColor(activeColor);

  document.querySelectorAll('.admin-only').forEach((el) => {
    if (isAdmin) {
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  });

  document.querySelectorAll('.tech-or-admin-only').forEach((el) => {
    if (isAdmin || isTech) {
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  });

  // Exibe filtro de solicitante para Admin e Técnico
  const filterUser = document.getElementById('filter-user');
  if (filterUser) {
    if (isAdmin || isTech) filterUser.classList.remove('hidden');
    else filterUser.classList.add('hidden');
  }

  const clientName = userObj?.clientId ? getClientNameById(userObj.clientId) : '';

  const roleLabels = {
    ADMIN: 'Hierarquia: Administrador Geral',
    TECH: `Hierarquia: Técnico (${session.department || 'Suporte'})`,
    USER: `Hierarquia: Usuário Comum (${clientName || session.department || 'Solicitante'})`
  };

  const badgeLabels = {
    ADMIN: 'Acesso Total & Direcionamento',
    TECH: 'Fila Técnica & SLA',
    USER: clientName ? `Contrato: ${clientName}` : 'Portal do Solicitante'
  };

  const navTicketLabels = {
    ADMIN: 'Chamados & Triagem',
    TECH: 'Meus Atendimentos',
    USER: 'Meus Chamados'
  };

  const navDashLabels = {
    ADMIN: 'Relatório Geral (Tudo)',
    TECH: 'Relatório Técnico & SLA',
    USER: 'Meu Relatório Individual'
  };

  const displayName = userObj?.name || session.name || 'Usuário';
  const avatarSrc = userObj ? userObj.avatar : session.userId ? session.avatar : contract.adminAvatar || session.avatar;

  document.getElementById('logged-user-name').textContent = displayName;
  document.getElementById('logged-user-role').textContent = roleLabels[role] || roleLabels.USER;
  document.getElementById('sidebar-role-badge').textContent = badgeLabels[role] || badgeLabels.USER;
  document.getElementById('nav-tickets-label').textContent = navTicketLabels[role] || navTicketLabels.USER;

  const avatarImg = document.getElementById('logged-user-avatar-img');
  const avatarFallback = document.getElementById('logged-user-avatar-fallback');
  if (avatarImg && avatarFallback) {
    if (avatarSrc) {
      avatarImg.src = avatarSrc;
      avatarImg.classList.remove('hidden');
      avatarFallback.classList.add('hidden');
    } else {
      avatarImg.src = '';
      avatarImg.classList.add('hidden');
      avatarFallback.textContent = getInitials(displayName);
      avatarFallback.classList.remove('hidden');
    }
  }

  const dashLabel = document.getElementById('nav-dashboard-label');
  if (dashLabel) dashLabel.textContent = navDashLabels[role] || navDashLabels.USER;

  // Se o usuário estiver no 1º acesso (troca de senha obrigatória), direciona para a aba de Perfil
  if (isSessionForcedPasswordChange(session)) {
    currentTab = 'profile';
    document.querySelectorAll('.tab-section').forEach((sec) => sec.classList.remove('active'));
    document.getElementById('tab-profile')?.classList.add('active');
    return;
  }

  // Técnico pode acessar 'tickets', 'dashboard', 'solutions' e 'profile'; Usuário Comum pode acessar 'tickets', 'dashboard' e 'profile'
  const allowedNonAdminTabs = isTech
    ? ['tickets', 'dashboard', 'solutions', 'profile']
    : ['tickets', 'dashboard', 'profile'];
  if (!isAdmin && !allowedNonAdminTabs.includes(currentTab)) {
    currentTab = 'tickets';
    document.querySelectorAll('.tab-section').forEach((sec) => sec.classList.remove('active'));
    document.getElementById('tab-tickets')?.classList.add('active');
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const identifier = document.getElementById('login-identifier').value;
  const password = document.getElementById('login-password').value;

  try {
    const session = await window.db.login(identifier, password);
    document.getElementById('login-password').value = '';
    checkAuthAndRender();
    if (isSessionForcedPasswordChange(session)) {
      switchTab('profile');
      showToast(
        `Primeiro acesso detectado! Por favor, altere sua senha temporária na aba Meu Perfil para continuar.`,
        'info'
      );
      setTimeout(() => document.getElementById('pwd-current')?.focus(), 150);
    } else {
      showToast(`Bem-vindo(a), ${session.name}!`);
    }
  } catch (err) {
    showToast(err.message || 'Credenciais inválidas.', 'error');
  }
}

async function loginAsUserQuick(userId) {
  const user = window.db.getUsers().find((u) => u.id === userId);
  if (!user) return;
  if (user.isBlocked) {
    showToast(`O usuário ${user.name} está bloqueado. Desbloqueie antes de testar o acesso.`, 'error');
    return;
  }
  try {
    const session = await window.db.login(user.email, user.password || '123456');
    checkAuthAndRender();
    if (isSessionForcedPasswordChange(session)) {
      switchTab('profile');
      showToast(
        `Logado como ${user.name} (1º Acesso: Troca de senha obrigatória ativa na aba Meu Perfil).`,
        'info'
      );
    } else {
      switchTab('tickets');
      const roleName =
        user.accessRole === 'ADMIN'
          ? 'Administrador'
          : user.accessRole === 'TECH'
          ? 'Técnico'
          : 'Usuário Comum';
      showToast(`Logado como ${user.name} (${roleName})`);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function handleLogout() {
  window.db.logout();
  checkAuthAndRender();
}

function refreshAllViews() {
  const session = window.db.getSession();
  if (session) {
    applyRolePermissions(session);
  }
  applyCompanyBranding();
  updateHeaderAndSidebarStats();
  populateFilterDropdowns();
  populateTechnicianDatalist();
  renderTickets();
  renderDashboard();
  renderSolutionsBank();
  renderInventory();
  renderUsers();
  renderProblemTypes();
  loadSettingsForms();
  loadProfileTab();
  if (window.lucide) {
    lucide.createIcons();
  }
}

// ==========================================
// NAVEGAÇÃO ENTRE ABAS (RESPEITANDO HIERARQUIA & TROCA DE SENHA OBRIGATÓRIA NO 1º ACESSO)
// ==========================================
function switchTab(tabName) {
  const session = window.db.getSession();
  const role = session?.role || 'USER';

  if (isSessionForcedPasswordChange(session) && tabName !== 'profile') {
    showToast(
      'Troca de senha obrigatória no 1º acesso! Cadastre sua nova senha pessoal abaixo antes de acessar outras abas.',
      'error'
    );
    tabName = 'profile';
  }

  // Técnico e Admin têm acesso a Inventário e Banco de Soluções; Usuário Comum pode visualizar chamados, relatórios, inventário e perfil
  const allowedTabsForRole =
    role === 'TECH'
      ? ['tickets', 'dashboard', 'solutions', 'inventory', 'profile']
      : ['tickets', 'dashboard', 'inventory', 'profile'];
  if (role !== 'ADMIN' && !allowedTabsForRole.includes(tabName)) {
    showToast('Acesso restrito ao perfil Administrador.', 'error');
    return;
  }

  currentTab = tabName;
  document.querySelectorAll('.tab-section').forEach((sec) => sec.classList.remove('active'));
  const target = document.getElementById(`tab-${tabName}`);
  if (target) target.classList.add('active');

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.remove('bg-indigo-600', 'text-white');
    btn.classList.add('text-slate-300', 'hover:bg-slate-800', 'hover:text-white');
  });
  const activeBtn = document.getElementById(`nav-${tabName}`);
  if (activeBtn) {
    activeBtn.classList.remove('text-slate-300', 'hover:bg-slate-800');
    activeBtn.classList.add('bg-indigo-600', 'text-white');
  }

  const titlesByRole = {
    tickets: {
      ADMIN: [
        'Central de Chamados & Direcionamento (Administrador)',
        'Receba os novos chamados, direcione para os Técnicos ou atenda você mesmo, com edição total'
      ],
      TECH: [
        `Fila Técnica de Atendimento (${session?.name || 'Técnico'})`,
        'Atenda os chamados direcionados a você pelo Administrador, aponte horas e cumpra o SLA'
      ],
      USER: [
        `Meus Chamados Técnicos (${session?.name || 'Solicitante'})`,
        'Abra solicitações de suporte para o Administrador e acompanhe o cronômetro de SLA em tempo real'
      ]
    },
    dashboard: {
      ADMIN: [
        'Relatório Gerencial Completo (Visão Administrador)',
        'Métricas globais de todo o contrato fixo, todos os usuários, problemas e produtividade de técnicos'
      ],
      TECH: [
        `Relatório de Desempenho Técnico (${session?.name || 'Técnico'})`,
        'Indicadores de cumprimento de SLA, horas apontadas e chamados atendidos na sua fila técnica'
      ],
      USER: [
        `Relatório Individual de Chamados (${session?.name || 'Solicitante'})`,
        'Resumo consolidado, cumprimento de SLA e exportação dos chamados abertos por você'
      ]
    },
    solutions: [
      'Banco de Soluções Técnicas (Base de Conhecimento)',
      'Histórico de problemas encontrados e serviços realizados nos atendimentos finalizados para consulta rápida da equipe'
    ],
    inventory: [
      'Inventário de Equipamentos TI & Histórico de Ativos',
      'Gestão de Desktops, Notebooks, Servidores e Redes com histórico correlacionado de atendimentos'
    ],
    users: [
      'Gerenciamento de Usuários, Contratos, Senhas & Bloqueios',
      'Vincule o contrato de cada usuário, edite dados, desbloqueie/redefina senhas, bloqueie acessos e exclua'
    ],
    problems: [
      'Catálogo de Problemas & Tempos de SLA',
      'Configure os tipos de problema e seus respectivos prazos máximos de atendimento'
    ],
    settings: [
      'Clientes & Contratos Fixos, Identidade Visual & Banco SQL',
      'Cadastre múltiplos clientes de contrato fixo, personalize a logo da sua empresa e gerencie o banco SQLite'
    ],
    profile: [
      'Meu Perfil & Configurações (Foto, Senha e Cor)',
      'Todos os usuários podem alterar a foto de perfil, trocar a senha (obrigatória no 1º acesso) e mudar a cor do sistema'
    ]
  };

  if (tabName === 'tickets' || tabName === 'dashboard') {
    const pair = titlesByRole[tabName][role] || titlesByRole[tabName].USER;
    document.getElementById('page-title').textContent = pair[0];
    document.getElementById('page-subtitle').textContent = pair[1];
  } else if (titlesByRole[tabName]) {
    document.getElementById('page-title').textContent = titlesByRole[tabName][0];
    document.getElementById('page-subtitle').textContent = titlesByRole[tabName][1];
  }

  refreshAllViews();
}

// ==========================================
// CÁLCULO DE SLA, EXPEDIENTE COMERCIAL & FORMATAÇÃO DE TEMPO
// ==========================================
function isCurrentTimeInBusinessHours(contract = null) {
  const cfg = contract || window.db.getContract() || {};
  const startStr = cfg.businessHoursStart || '08:00';
  const endStr = cfg.businessHoursEnd || '18:00';
  const daysStr = cfg.businessDays || '1,2,3,4,5';
  const lunchEnabled = cfg.lunchBreakEnabled !== false && cfg.lunchBreakEnabled !== 0 && cfg.lunchBreakEnabled !== '0';
  const lunchStartStr = cfg.lunchStart || '12:00';
  const lunchEndStr = cfg.lunchEnd || '13:00';

  let sh = 8, sm = 0, eh = 18, em = 0;
  try {
    const [pSh, pSm] = startStr.split(':').map(Number);
    const [pEh, pEm] = endStr.split(':').map(Number);
    if (!isNaN(pSh)) { sh = pSh; sm = pSm || 0; }
    if (!isNaN(pEh)) { eh = pEh; em = pEm || 0; }
  } catch (_) {}

  let lsh = 12, lsm = 0, leh = 13, lem = 0, hasLunch = Boolean(lunchEnabled);
  if (hasLunch) {
    try {
      const [pLsh, pLsm] = lunchStartStr.split(':').map(Number);
      const [pLeh, pLem] = lunchEndStr.split(':').map(Number);
      if (!isNaN(pLsh) && !isNaN(pLeh)) {
        lsh = pLsh; lsm = pLsm || 0;
        leh = pLeh; lem = pLem || 0;
        const openM = sh * 60 + sm;
        const closeM = eh * 60 + em;
        const lOpenM = lsh * 60 + lsm;
        const lCloseM = leh * 60 + lem;
        if (!(openM < lOpenM && lOpenM < lCloseM && lCloseM < closeM)) {
          hasLunch = false;
        }
      } else {
        hasLunch = false;
      }
    } catch (_) {
      hasLunch = false;
    }
  }

  const allowedDays = daysStr.split(',').map((x) => Number(x.trim())).filter((x) => !isNaN(x) && x >= 1 && x <= 7);
  const validDays = allowedDays.length > 0 ? allowedDays : [1, 2, 3, 4, 5];

  const now = new Date();
  const jsDay = now.getDay();
  const isoDay = jsDay === 0 ? 7 : jsDay;
  const currMin = now.getHours() * 60 + now.getMinutes();
  const openMin = sh * 60 + sm;
  const closeMin = eh * 60 + em;

  const isDayValid = validDays.includes(isoDay);
  const isWithinWorkHours = currMin >= openMin && currMin < closeMin;
  const isLunch = hasLunch && isDayValid && currMin >= (lsh * 60 + lsm) && currMin < (leh * 60 + lem);
  const isOpen = isDayValid && isWithinWorkHours && !isLunch;

  return {
    isOpen,
    isLunch,
    startStr,
    endStr,
    daysStr,
    lunchEnabled: hasLunch,
    lunchStartStr,
    lunchEndStr
  };
}

function evaluateTicketSla(ticket) {
  const now = new Date();
  const created = new Date(ticket.createdAt);
  const due = new Date(ticket.dueAt);
  const contract = window.db.getContract();
  const bhStatus = isCurrentTimeInBusinessHours(contract);

  // 1. SLA DE PRIMEIRA RESPOSTA (Aceite pelo Técnico ou Início do Atendimento)
  let firstResponseResult = null;
  const firstRespDue = ticket.firstResponseDueAt
    ? new Date(ticket.firstResponseDueAt)
    : new Date(created.getTime() + (Number(ticket.firstResponseSlaHours) || 1.0) * 3600000);
  const respondedAtStr = ticket.firstRespondedAt || ticket.startedAt;

  if (respondedAtStr) {
    const respondedDt = new Date(respondedAtStr);
    const met = respondedDt <= firstRespDue;
    const diffMinutes = Math.max(1, Math.round((respondedDt - created) / 60000));
    firstResponseResult = {
      status: met ? 'MET' : 'MISSED',
      label: met ? `1ª Resposta em ${formatDurationMinutes(diffMinutes)} (No SLA)` : `1ª Resposta em ${formatDurationMinutes(diffMinutes)} (Fora do SLA)`,
      badgeClass: met ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-amber-100 text-amber-800 border-amber-300',
      metSla: met
    };
  } else if (ticket.status === 'Resolvido') {
    firstResponseResult = {
      status: 'MET',
      label: '1ª Resposta Concluída',
      badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-300',
      metSla: true
    };
  } else {
    const diffRespMs = firstRespDue - now;
    if (diffRespMs < 0) {
      const overdueMin = Math.abs(Math.round(diffRespMs / 60000));
      firstResponseResult = {
        status: 'EXPIRED',
        label: `1ª Resposta Pendente (Atrasada -${formatDurationMinutes(overdueMin)})`,
        badgeClass: 'bg-rose-100 text-rose-800 border-rose-300 animate-pulse',
        metSla: false
      };
    } else {
      const leftMin = Math.round(diffRespMs / 60000);
      let pLabel = `1ª Resposta em até ${formatDurationMinutes(leftMin)}`;
      let pClass = 'bg-indigo-100 text-indigo-800 border-indigo-300';
      if (bhStatus.isLunch) {
        pLabel = `🍽️ Almoço • 1ª Resposta após ${bhStatus.lunchEndStr}`;
        pClass = 'bg-amber-100 text-amber-900 border-amber-300';
      } else if (!bhStatus.isOpen) {
        pLabel = `1ª Resposta em horário útil (SLA Pausado)`;
        pClass = 'bg-amber-50 text-amber-900 border-amber-300';
      }
      firstResponseResult = {
        status: !bhStatus.isOpen ? 'PAUSED' : 'PENDING',
        label: pLabel,
        badgeClass: pClass,
        metSla: true
      };
    }
  }

  // 2. SLA DE RESOLUÇÃO FINAL
  if (ticket.status === 'Resolvido') {
    const resolved = ticket.resolvedAt ? new Date(ticket.resolvedAt) : now;
    const metSla = resolved <= due;
    const durationHours = ((resolved - created) / 3600000).toFixed(1);
    return {
      code: metSla ? 'RESOLVED_OK' : 'RESOLVED_LATE',
      label: metSla ? `Atendido no SLA (${durationHours}h)` : `Concluído fora do SLA (${durationHours}h)`,
      badgeClass: metSla
        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
        : 'bg-amber-50 text-amber-700 border-amber-200',
      icon: metSla ? 'check-circle' : 'alert-circle',
      metSla,
      firstResponse: firstResponseResult,
      isPausedOutsideHours: false
    };
  }

  const diffMs = due - now;
  const totalSlaMs = (Number(ticket.slaHours) || 4) * 3600000;
  const remainingRatio = diffMs / totalSlaMs;
  const isPaused = !bhStatus.isOpen;

  if (diffMs < 0) {
    const overdueMin = Math.abs(Math.round(diffMs / 60000));
    return {
      code: 'EXPIRED',
      label: `SLA Estourado (-${formatDurationMinutes(overdueMin)})`,
      badgeClass: 'bg-rose-100 text-rose-800 border-rose-300 sla-badge-expired',
      icon: 'flame',
      metSla: false,
      firstResponse: firstResponseResult,
      isPausedOutsideHours: isPaused
    };
  }

  const leftMin = Math.round(diffMs / 60000);
  const pauseSuffix = bhStatus.isLunch ? ' • Pausa de Almoço' : isPaused ? ' • Expediente Pausado' : '';

  if (remainingRatio <= 0.25 || leftMin <= 45) {
    return {
      code: 'WARNING',
      label: `Vence em ${formatDurationMinutes(leftMin)}${pauseSuffix}`,
      badgeClass: 'bg-amber-100 text-amber-800 border-amber-300',
      icon: 'clock-alert',
      metSla: true,
      firstResponse: firstResponseResult,
      isPausedOutsideHours: isPaused
    };
  }

  return {
    code: 'OK',
    label: `No prazo (${formatDurationMinutes(leftMin)} restantes${pauseSuffix})`,
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    icon: 'clock',
    metSla: true,
    firstResponse: firstResponseResult,
    isPausedOutsideHours: isPaused
  };
}

function formatDurationMinutes(totalMinutes) {
  if (totalMinutes < 60) {
    return `${totalMinutes}min`;
  }
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatDateTimeBR(isoString) {
  if (!isoString) return '--';
  const d = new Date(isoString);
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// ==========================================
// ATUALIZAÇÃO DO CABEÇALHO, SIDEBAR E KPIs
// ==========================================
function getClientNameById(clientId) {
  if (!clientId) return '';
  const clients = window.db.getClients();
  const found = clients.find((c) => c.id === clientId);
  return found ? found.name : '';
}

function updateHeaderAndSidebarStats() {
  const session = window.db.getSession();
  const isAdmin = session?.role === 'ADMIN';
  const contract = window.db.getContract();
  const clients = window.db.getClients();
  const allTickets = window.db.getTickets();
  const users = window.db.getUsers();
  const problems = window.db.getProblemTypes();

  // Filtra chamados pelo escopo da hierarquia do usuário logado
  const tickets = getScopedTicketsForSession(session, allTickets);

  // Determina resumo de Clientes e Horas na Sidebar
  const userObj = session?.userId ? users.find((u) => u.id === session.userId) : null;
  const userClient = userObj?.clientId ? clients.find((c) => c.id === userObj.clientId) : null;

  let clientLabel = contract.clientName || 'Cliente não cadastrado';
  let contractSubLabel = contract.contractNumber ? `Contrato: ${contract.contractNumber}` : 'Contrato: Não definido';
  let totalHoursUsed = allTickets.reduce((acc, t) => acc + (Number(t.hoursSpent) || 0), 0);
  let quota = Number(contract.monthlyHoursQuota) || 0;

  if (userClient && session?.role === 'USER') {
    clientLabel = userClient.name;
    contractSubLabel = userClient.contractNumber ? `Contrato: ${userClient.contractNumber}` : 'Contrato Fixo Ativo';
    totalHoursUsed = allTickets
      .filter((t) => t.clientId === userClient.id || t.userId === userObj.id)
      .reduce((acc, t) => acc + (Number(t.hoursSpent) || 0), 0);
    quota = Number(userClient.monthlyHoursQuota) || 0;
  } else if (clients.length > 0) {
    if (clients.length === 1) {
      clientLabel = clients[0].name;
      contractSubLabel = clients[0].contractNumber
        ? `Contrato: ${clients[0].contractNumber}`
        : '1 Cliente de Contrato Ativo';
      quota = Number(clients[0].monthlyHoursQuota) || quota;
    } else {
      clientLabel = `${clients.length} Clientes de Contrato`;
      contractSubLabel = `Gestão Multi-Contratos Ativa`;
      quota = clients.reduce((acc, c) => acc + (Number(c.monthlyHoursQuota) || 0), 0);
    }
  }

  document.getElementById('sidebar-client-name').textContent = clientLabel;
  document.getElementById('sidebar-contract-number').textContent = contractSubLabel;
  document.getElementById('header-client-badge').textContent = clientLabel;

  const badgeClients = document.getElementById('badge-clients-count');
  if (badgeClients) badgeClients.textContent = clients.length;

  const pctHours = quota > 0 ? Math.min(100, Math.round((totalHoursUsed / quota) * 100)) : 0;

  document.getElementById('sidebar-hours-summary').textContent = `${totalHoursUsed.toFixed(1)}h / ${quota}h`;
  const bar = document.getElementById('sidebar-hours-bar');
  bar.style.width = `${pctHours}%`;
  bar.className = `h-full rounded-full transition-all duration-300 ${
    pctHours >= 90 ? 'bg-rose-500' : pctHours >= 75 ? 'bg-amber-400' : 'bg-indigo-500'
  }`;

  // Exibe ou oculta banner de Onboarding (quando banco está zerado)
  const onboarding = document.getElementById('onboarding-banner');
  if (onboarding) {
    if (isAdmin && (users.length === 0 || problems.length === 0 || (clients.length === 0 && !contract.clientName))) {
      onboarding.classList.remove('hidden');
    } else {
      onboarding.classList.add('hidden');
    }
  }

  // Contadores de chamados do escopo
  const openTickets = tickets.filter((t) => t.status !== 'Resolvido');
  const resolvedTickets = tickets.filter((t) => t.status === 'Resolvido');

  // Banner de Triagem do Administrador: Chamados que chegaram para o Admin direcionar ou atender
  const triageBanner = document.getElementById('admin-triage-banner');
  const triageTitle = document.getElementById('admin-triage-title');
  if (triageBanner && triageTitle) {
    const pendingTriageCount = allTickets.filter(
      (t) => t.status !== 'Resolvido' && isTicketAwaitingAdminTriage(t)
    ).length;
    if (isAdmin && pendingTriageCount > 0) {
      triageBanner.classList.remove('hidden');
      triageTitle.textContent = `${pendingTriageCount} chamado(s) aguardando seu direcionamento ou atendimento direto`;
    } else {
      triageBanner.classList.add('hidden');
    }
  }

  let expiredCount = 0;
  let warningCount = 0;
  let onTimeOpenCount = 0;

  openTickets.forEach((t) => {
    const sla = evaluateTicketSla(t);
    if (sla.code === 'EXPIRED') expiredCount++;
    else if (sla.code === 'WARNING') {
      warningCount++;
      onTimeOpenCount++;
    } else {
      onTimeOpenCount++;
    }
  });

  const resolvedOnTime = resolvedTickets.filter((t) => evaluateTicketSla(t).metSla).length;
  const complianceRate =
    resolvedTickets.length > 0 ? Math.round((resolvedOnTime / resolvedTickets.length) * 100) : 100;

  document.getElementById('badge-open-tickets').textContent = openTickets.length;
  document.getElementById('badge-users-count').textContent = users.length;

  const badgeSolutions = document.getElementById('badge-solutions-count');
  if (badgeSolutions) {
    badgeSolutions.textContent = window.db.getSolutions().length;
  }

  const badgeInventory = document.getElementById('badge-inventory-count');
  if (badgeInventory) {
    badgeInventory.textContent = window.db.getEquipments().length;
  }

  document.getElementById('kpi-open-count').textContent = openTickets.length;
  document.getElementById('kpi-ontime-count').textContent = onTimeOpenCount;
  document.getElementById('kpi-expired-count').textContent = expiredCount;
  document.getElementById('kpi-resolved-count').textContent = resolvedTickets.length;
  document.getElementById('kpi-sla-compliance').textContent = `${complianceRate}% dentro do SLA contratual`;

  // Banner superior de urgência
  const urgentBanner = document.getElementById('urgent-sla-banner');
  const urgentText = document.getElementById('urgent-sla-text');
  const urgentTotal = expiredCount + warningCount;
  if (urgentTotal > 0) {
    urgentBanner.classList.remove('hidden');
    urgentText.textContent =
      expiredCount > 0
        ? `${expiredCount} SLA estourado(s) • ${warningCount} em atenção`
        : `${warningCount} chamado(s) próximo(s) do vencimento SLA`;
  } else {
    urgentBanner.classList.add('hidden');
  }

  // Status do Banco SQLite na Sidebar
  const dot = document.getElementById('cloud-status-dot');
  const label = document.getElementById('cloud-status-label');
  if (window.db.sqliteConnected) {
    dot.className = 'w-2 h-2 rounded-full bg-emerald-400';
    label.textContent = 'Banco SQLite Conectado';
  } else {
    dot.className = 'w-2 h-2 rounded-full bg-amber-400';
    label.textContent = 'Banco Local (Offline)';
  }

  // Indicador de Horário de Expediente / SLA na Topbar
  const bhIndicator = document.getElementById('header-business-hours-indicator');
  const bhText = document.getElementById('header-business-hours-text');
  if (bhIndicator && bhText) {
    const bh = isCurrentTimeInBusinessHours(contract);
    if (bh.isLunch) {
      bhIndicator.className = 'hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors bg-amber-50 text-amber-900 border border-amber-300 hover:bg-amber-100';
      bhText.textContent = `Pausa de Almoço (SLA Pausado até ${bh.lunchEndStr})`;
    } else if (bh.isOpen) {
      bhIndicator.className = 'hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100';
      bhText.textContent = `Expediente Ativo (${bh.startStr} - ${bh.endStr})`;
    } else {
      bhIndicator.className = 'hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors bg-slate-100 text-slate-700 border border-slate-300 hover:bg-slate-200';
      bhText.textContent = `Fora do Expediente (SLA Pausado)`;
    }
  }
}

function filterTriageTickets() {
  const statusSelect = document.getElementById('filter-status');
  if (statusSelect) {
    statusSelect.value = 'TRIAGE';
    renderTickets();
  }
}

function populateTechnicianDatalist() {
  const datalist = document.getElementById('tech-options-datalist');
  if (!datalist) return;
  const users = window.db.getUsers();
  const techs = users.filter((u) => (u.accessRole === 'TECH' || u.accessRole === 'ADMIN') && !u.isBlocked);
  const options = [
    'Administrador Geral (Atendimento Direto)',
    'Aguardando Direcionamento (Admin)',
    'Fila Técnica Geral',
    ...techs.map((t) => t.name)
  ];
  datalist.innerHTML = Array.from(new Set(options))
    .map((name) => `<option value="${escapeHtml(name)}"></option>`)
    .join('');
}

// ==========================================
// LISTAGEM E FILTRO DE CHAMADOS (INCLUINDO MÚLTIPLOS CLIENTES)
// ==========================================
function populateFilterDropdowns() {
  const users = window.db.getUsers();
  const clients = window.db.getClients();
  const problems = window.db.getProblemTypes();

  const filterUser = document.getElementById('filter-user');
  if (filterUser) {
    const currentVal = filterUser.value || 'ALL';
    filterUser.innerHTML = `<option value="ALL">Todos os Usuários (${users.length})</option>`;
    users.forEach((u) => {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = `${u.name} (${u.department})`;
      filterUser.appendChild(opt);
    });
    filterUser.value = currentVal;
  }

  // Filtro de Clientes na aba Chamados
  const filterClient = document.getElementById('filter-client');
  if (filterClient) {
    const curCli = filterClient.value || 'ALL';
    filterClient.innerHTML = `<option value="ALL">Todos os Clientes (${clients.length})</option>`;
    clients.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name}${c.contractNumber ? ' (' + c.contractNumber + ')' : ''}`;
      filterClient.appendChild(opt);
    });
    filterClient.value = curCli;
  }

  // Filtro de Clientes no Relatório / Dashboard
  const dashFilterClient = document.getElementById('dash-filter-client');
  if (dashFilterClient) {
    const curDashCli = dashFilterClient.value || 'ALL';
    dashFilterClient.innerHTML = `<option value="ALL">Visão Consolidada — Todos os Clientes (${clients.length})</option>`;
    clients.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `Cliente: ${c.name} (${c.monthlyHoursQuota || 0}h/mês)`;
      dashFilterClient.appendChild(opt);
    });
    dashFilterClient.value = curDashCli;
  }

  // Seletor de Contrato / Empresa Cliente no cadastro de Usuário
  const userClientSel = document.getElementById('user-client-id');
  if (userClientSel) {
    const curUserCli = userClientSel.value || '';
    userClientSel.innerHTML = `<option value="">Sem vínculo específico / Equipe Técnica Interna</option>`;
    clients.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `Contrato: ${c.name}${c.contractNumber ? ' (' + c.contractNumber + ')' : ''} — Franquia ${c.monthlyHoursQuota || 0}h/mês`;
      userClientSel.appendChild(opt);
    });
    userClientSel.value = curUserCli;
    onUserContractSelectChange();
  }

  // Filtro e seletor de Tipo de Problema no Banco de Soluções
  const solFilterProb = document.getElementById('sol-filter-problem');
  if (solFilterProb) {
    const curSolProb = solFilterProb.value || 'ALL';
    solFilterProb.innerHTML = `<option value="ALL">Todas as Categorias / Problemas (${problems.length})</option>`;
    problems.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.category})`;
      solFilterProb.appendChild(opt);
    });
    solFilterProb.value = curSolProb;
  }

  const solFormProb = document.getElementById('sol-problem-type');
  if (solFormProb) {
    const curFormProb = solFormProb.value || '';
    solFormProb.innerHTML = `<option value="">Geral / Sem categoria específica</option>`;
    problems.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.category})`;
      solFormProb.appendChild(opt);
    });
    solFormProb.value = curFormProb;
  }
}

function renderTickets() {
  const session = window.db.getSession();
  const role = session?.role || 'USER';
  const allTickets = window.db.getTickets();
  const users = window.db.getUsers();
  const clients = window.db.getClients();
  const problems = window.db.getProblemTypes();

  // Filtra chamados respeitando a hierarquia (ADMIN = todos, TECH = direcionados a ele, USER = próprios)
  const baseTickets = getScopedTicketsForSession(session, allTickets);

  const search = (document.getElementById('filter-search')?.value || '').toLowerCase().trim();
  const clientFilter = document.getElementById('filter-client')?.value || 'ALL';
  const statusFilter = document.getElementById('filter-status')?.value || 'ALL';
  const slaFilter = document.getElementById('filter-sla')?.value || 'ALL';
  const userFilter = document.getElementById('filter-user')?.value || 'ALL';

  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
  const clientMap = Object.fromEntries(clients.map((c) => [c.id, c]));
  const probMap = Object.fromEntries(problems.map((p) => [p.id, p]));

  const filtered = baseTickets.filter((t) => {
    const u = userMap[t.userId];
    const effectiveClientId = t.clientId || u?.clientId || '';
    const cli = clientMap[effectiveClientId];
    const p = probMap[t.problemTypeId];
    const sla = evaluateTicketSla(t);

    if (role === 'ADMIN' && clientFilter !== 'ALL' && effectiveClientId !== clientFilter) {
      return false;
    }

    if (statusFilter === 'TRIAGE') {
      if (t.status === 'Resolvido' || !isTicketAwaitingAdminTriage(t)) return false;
    } else if (statusFilter === 'OPEN_ONLY' && t.status === 'Resolvido') {
      return false;
    } else if (
      statusFilter !== 'ALL' &&
      statusFilter !== 'OPEN_ONLY' &&
      statusFilter !== 'TRIAGE' &&
      t.status !== statusFilter
    ) {
      return false;
    }

    if (slaFilter !== 'ALL') {
      if (slaFilter === 'EXPIRED' && sla.code !== 'EXPIRED') return false;
      if (slaFilter === 'WARNING' && sla.code !== 'WARNING') return false;
      if (slaFilter === 'OK' && sla.code !== 'OK') return false;
    }

    if ((role === 'ADMIN' || role === 'TECH') && userFilter !== 'ALL' && t.userId !== userFilter) return false;

    if (search) {
      const haystack = [
        t.id,
        t.title,
        t.description,
        t.technician,
        u?.name || '',
        u?.department || '',
        cli?.name || '',
        cli?.contractNumber || '',
        p?.name || ''
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }

    return true;
  });

  const tbody = document.getElementById('tickets-table-body');
  if (!tbody) return;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-12 text-center text-slate-400 text-sm">
          <div class="max-w-sm mx-auto space-y-2">
            <p class="font-semibold text-slate-600">Nenhum chamado encontrado para este filtro.</p>
            <p class="text-xs text-slate-400">Clique em <strong>"Abrir Novo Chamado"</strong> no canto superior direito para registrar uma solicitação.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered
    .map((t) => {
      const user = userMap[t.userId] || { name: 'Usuário não encontrado', department: '--', isVip: false, avatar: '', clientId: '' };
      const effectiveClientId = t.clientId || user.clientId || '';
      const clientObj = clientMap[effectiveClientId];
      const problem = probMap[t.problemTypeId] || { name: 'Geral', category: 'Suporte' };
      const sla = evaluateTicketSla(t);
      const awaitingTriage = t.status !== 'Resolvido' && isTicketAwaitingAdminTriage(t);

      const priorityColors = {
        Crítica: 'bg-rose-50 text-rose-700 border-rose-200',
        Alta: 'bg-orange-50 text-orange-700 border-orange-200',
        Média: 'bg-indigo-50 text-indigo-700 border-indigo-200',
        Baixa: 'bg-slate-100 text-slate-600 border-slate-200',
        Planejada: 'bg-teal-50 text-teal-700 border-teal-200'
      };

      const statusColors = {
        Aberto: 'bg-sky-50 text-sky-700 border-sky-200',
        'Em Atendimento': 'bg-indigo-50 text-indigo-700 border-indigo-200',
        'Aguardando Cliente': 'bg-amber-50 text-amber-700 border-amber-200',
        Resolvido: 'bg-emerald-50 text-emerald-700 border-emerald-200'
      };

      const userAvatarHtml = user.avatar
        ? `<img src="${user.avatar}" alt="${escapeHtml(user.name)}" class="w-8 h-8 rounded-full object-cover border border-slate-200 shrink-0" />`
        : `<div class="w-8 h-8 rounded-full bg-indigo-50 text-indigo-700 font-bold text-[11px] flex items-center justify-center border border-indigo-200 shrink-0">${getInitials(user.name)}</div>`;

      const techDisplayHtml = awaitingTriage
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 text-amber-900 font-semibold text-[11px]">Aguardando Direcionamento (Admin)</span>`
        : `<strong class="text-slate-700">${escapeHtml(t.technician)}</strong>`;

      const clientBadgeHtml = clientObj
        ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-semibold">Contrato: ${escapeHtml(clientObj.name)}</span>`
        : '';

      return `
        <tr class="hover:bg-slate-50/90 transition-colors">
          <td class="py-3.5 px-4">
            <div class="flex items-center gap-2">
              <span class="font-mono text-xs font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">${escapeHtml(t.id)}</span>
              <span class="text-[11px] px-2 py-0.5 rounded-full border font-medium ${priorityColors[t.priority] || priorityColors['Média']}">${escapeHtml(t.priority)}</span>
            </div>
            <p class="font-semibold text-slate-900 mt-1 line-clamp-1 cursor-pointer hover:text-indigo-600" onclick="openDetailModal('${t.id}')">${escapeHtml(t.title)}</p>
            <p class="text-xs text-slate-400 mt-0.5">Aberto em ${formatDateTimeBR(t.createdAt)} • Responsável: ${techDisplayHtml}</p>
          </td>

          <td class="py-3.5 px-4">
            <div class="flex items-center gap-2.5">
              ${userAvatarHtml}
              <div>
                <div class="flex items-center gap-1.5">
                  <span class="font-medium text-slate-900">${escapeHtml(user.name)}</span>
                  ${
                    user.isVip
                      ? `<span class="px-1.5 py-0.2 bg-amber-100 text-amber-800 border border-amber-300 rounded text-[10px] font-bold">VIP</span>`
                      : ''
                  }
                </div>
                <p class="text-xs text-slate-500">${escapeHtml(user.department)}</p>
                ${clientBadgeHtml ? `<div class="mt-0.5">${clientBadgeHtml}</div>` : ''}
              </div>
            </div>
          </td>

          <td class="py-3.5 px-4">
            <p class="font-medium text-slate-800 text-xs">${escapeHtml(problem.name)}</p>
            <p class="text-[11px] text-slate-400">SLA Contratual: <strong>${t.slaHours}h</strong></p>
          </td>

          <td class="py-3.5 px-4">
            <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${sla.badgeClass}">
              <i data-lucide="${sla.icon}" class="w-3.5 h-3.5"></i>
              ${sla.label}
            </span>
            <p class="text-[11px] text-slate-400 mt-1">Limite: ${formatDateTimeBR(t.dueAt)}</p>
          </td>

          <td class="py-3.5 px-4">
            <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border ${statusColors[t.status] || statusColors['Aberto']}">
              ${escapeHtml(t.status)}
            </span>
            ${
              t.status === 'Aberto' && !awaitingTriage
                ? `<span class="block text-[10px] text-amber-700 font-bold mt-1">⏳ Aguardando Aceite</span>`
                : t.status === 'Em Atendimento' && t.startedAt
                ? `<span class="block text-[10px] text-indigo-600 font-medium mt-1">Iniciado: ${formatDateTimeBR(t.startedAt)}</span>`
                : ''
            }
            ${
              t.hoursSpent > 0
                ? `<p class="text-[11px] text-slate-400 mt-0.5">${t.hoursSpent}h apontadas</p>`
                : ''
            }
          </td>

          <td class="py-3.5 px-4 text-right">
            <div class="inline-flex items-center justify-end gap-1.5">
              ${
                (role === 'TECH' || role === 'ADMIN') && t.status === 'Aberto' && !awaitingTriage
                  ? `<button onclick="handleAcceptAndStartTicket('${t.id}')" title="Aceitar chamado e iniciar atendimento agora" class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-xs transition-all cursor-pointer">
                       <i data-lucide="play" class="w-3.5 h-3.5 fill-current"></i>
                       <span>Iniciar</span>
                     </button>`
                  : ''
              }
              <button onclick="openDetailModal('${t.id}')" class="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg ${
                role === 'ADMIN' && awaitingTriage
                  ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-xs'
                  : 'bg-slate-100 hover:bg-indigo-600 hover:text-white text-slate-700'
              } text-xs font-semibold transition-colors cursor-pointer">
                ${
                  role === 'ADMIN'
                    ? awaitingTriage
                      ? 'Direcionar / Atender'
                      : 'Gerenciar / Editar'
                    : role === 'TECH'
                    ? 'Atender'
                    : 'Acompanhar'
                }
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  if (window.lucide) lucide.createIcons();
}

// ==========================================
// MODAL: NOVO CHAMADO TÉCNICO (COM EQUIPAMENTO + SLA EM HORÁRIO COMERCIAL)
// ==========================================
let isTicketEquipCreateMode = false;

function toggleNewTicketEquipMode() {
  isTicketEquipCreateMode = !isTicketEquipCreateMode;
  const selectBox = document.getElementById('ticket-equip-select-box');
  const createBox = document.getElementById('ticket-equip-create-box');
  const btn = document.getElementById('btn-toggle-equip-mode');

  if (isTicketEquipCreateMode) {
    selectBox?.classList.add('hidden');
    createBox?.classList.remove('hidden');
    if (btn) btn.textContent = '← Selecionar do Inventário existente';
  } else {
    selectBox?.classList.remove('hidden');
    createBox?.classList.add('hidden');
    if (btn) btn.textContent = '+ Cadastrar novo equipamento';
  }
}

function populateTicketEquipmentSelect() {
  const select = document.getElementById('ticket-equipment-select');
  if (!select) return;

  const equipments = window.db.getEquipments();
  const selectedUserId = document.getElementById('ticket-user')?.value;
  const selectedClientId = document.getElementById('ticket-client')?.value;

  let filtered = equipments;
  if (selectedClientId) {
    filtered = equipments.filter((e) => !e.clientId || e.clientId === selectedClientId);
  }

  select.innerHTML =
    `<option value="">Nenhum equipamento vinculado (Não se aplica / Serviço geral)</option>` +
    filtered
      .map((e) => {
        const userObj = e.userId ? window.db.getUsers().find((u) => u.id === e.userId) : null;
        const userTag = userObj ? ` • ${userObj.name}` : '';
        return `<option value="${e.id}">${escapeHtml(e.name)} — SN: ${escapeHtml(e.serialNumber)} (${escapeHtml(e.type)}${userTag})</option>`;
      })
      .join('');
}

function openNewTicketModal() {
  const session = window.db.getSession();
  if (isSessionForcedPasswordChange(session)) {
    showToast('Troque sua senha temporária na aba Meu Perfil antes de abrir chamados.', 'error');
    switchTab('profile');
    return;
  }
  const role = session?.role || 'USER';
  const isAdmin = role === 'ADMIN';
  const isTech = role === 'TECH';
  const users = window.db.getUsers();
  const clients = window.db.getClients();
  const problems = window.db.getProblemTypes();

  if (problems.length === 0) {
    if (isAdmin) {
      showToast('Cadastre pelo menos um Tipo de Problema e SLA antes de abrir um chamado.', 'error');
      switchTab('problems');
    } else {
      showToast('O catálogo de tipos de problema ainda não foi configurado pelo administrador.', 'error');
    }
    return;
  }

  isTicketEquipCreateMode = false;
  const selectBox = document.getElementById('ticket-equip-select-box');
  const createBox = document.getElementById('ticket-equip-create-box');
  const btnToggle = document.getElementById('btn-toggle-equip-mode');
  if (selectBox) selectBox.classList.remove('hidden');
  if (createBox) createBox.classList.add('hidden');
  if (btnToggle) btnToggle.textContent = '+ Cadastrar novo equipamento';

  const userSelect = document.getElementById('ticket-user');
  if (isAdmin || isTech) {
    userSelect.disabled = false;
    if (users.length === 0) {
      userSelect.innerHTML = `<option value="">Cadastre um usuário usando "+ Cadastrar novo usuário rápido" acima</option>`;
      if (isAdmin) document.getElementById('quick-user-box').classList.remove('hidden');
    } else {
      userSelect.innerHTML = users
        .map((u) => {
          const cliName = getClientNameById(u.clientId);
          return `<option value="${u.id}">${escapeHtml(u.name)} — ${escapeHtml(u.department)}${
            cliName ? ' (' + escapeHtml(cliName) + ')' : ''
          }${u.isVip ? ' ★ VIP' : ''}</option>`;
        })
        .join('');
      document.getElementById('quick-user-box').classList.add('hidden');
    }
  } else {
    // Usuário Comum logado: trava o próprio nome
    userSelect.innerHTML = `<option value="${session.userId}">${escapeHtml(session.name)} — ${escapeHtml(
      session.department || ''
    )}</option>`;
    userSelect.disabled = true;
    document.getElementById('quick-user-box').classList.add('hidden');
  }

  // Popula seletor de Empresa Cliente no chamado
  const clientSelect = document.getElementById('ticket-client');
  if (clientSelect) {
    clientSelect.innerHTML =
      `<option value="">Contrato Geral / Automático pelo Solicitante</option>` +
      clients
        .map(
          (c) =>
            `<option value="${c.id}">${escapeHtml(c.name)}${
              c.contractNumber ? ' • Contrato ' + escapeHtml(c.contractNumber) : ''
            }</option>`
        )
        .join('');
    clientSelect.disabled = role === 'USER' && Boolean(session.clientId);
  }

  onTicketUserChange();

  const probSelect = document.getElementById('ticket-problem');
  probSelect.innerHTML = problems
    .map(
      (p) =>
        `<option value="${p.id}">${escapeHtml(p.name)} (SLA Resolução: ${p.defaultSlaHours}h • 1ª Resp: ${p.firstResponseSlaHours || 1}h)</option>`
    )
    .join('');

  // Admin pode ajustar os SLAs e direcionamento
  document.getElementById('ticket-sla').readOnly = !isAdmin;
  const firstSlaInput = document.getElementById('ticket-first-response-sla');
  if (firstSlaInput) firstSlaInput.readOnly = !isAdmin;

  document.getElementById('ticket-tech-wrapper').style.display = isAdmin ? 'block' : 'none';
  document.getElementById('ticket-tech').value = 'Aguardando Direcionamento (Admin)';

  document.getElementById('ticket-title').value = '';
  document.getElementById('ticket-desc').value = '';

  const newEqName = document.getElementById('ticket-new-equip-name');
  const newEqSerial = document.getElementById('ticket-new-equip-serial');
  if (newEqName) newEqName.value = '';
  if (newEqSerial) newEqSerial.value = '';

  populateTicketEquipmentSelect();
  onProblemTypeChange();
  document.getElementById('modal-new-ticket').classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function onTicketUserChange() {
  const userId = document.getElementById('ticket-user')?.value;
  const clientSelect = document.getElementById('ticket-client');
  if (!userId || !clientSelect) return;
  const userObj = window.db.getUsers().find((u) => u.id === userId);
  if (userObj && userObj.clientId) {
    clientSelect.value = userObj.clientId;
  } else if (window.db.getClients().length === 1) {
    clientSelect.value = window.db.getClients()[0].id;
  } else {
    clientSelect.value = '';
  }
  populateTicketEquipmentSelect();
}

function closeNewTicketModal() {
  document.getElementById('modal-new-ticket').classList.add('hidden');
}

function goToInventoryFromNewTicketModal() {
  closeNewTicketModal();
  switchTab('inventory');
  openNewEquipmentModal();
}

function onProblemTypeChange() {
  const probId = document.getElementById('ticket-problem').value;
  const problems = window.db.getProblemTypes();
  const selected = problems.find((p) => p.id === probId);
  if (selected) {
    document.getElementById('ticket-sla').value = selected.defaultSlaHours;
    const firstSlaEl = document.getElementById('ticket-first-response-sla');
    if (firstSlaEl) firstSlaEl.value = selected.firstResponseSlaHours || 1;
    document.getElementById('ticket-priority').value = selected.priority;
  }
  updateTicketDuePreview();
}

function updateTicketDuePreview() {
  const slaHours = Number(document.getElementById('ticket-sla')?.value) || 4;
  const firstSlaHours = Number(document.getElementById('ticket-first-response-sla')?.value) || 1;
  const contract = window.db.getContract() || {};
  const now = new Date();

  const dueFinal = window.db.calculateBusinessDue(now, slaHours, contract);
  const dueFirst = window.db.calculateBusinessDue(now, firstSlaHours, contract);

  const finalEl = document.getElementById('ticket-due-preview');
  const firstEl = document.getElementById('ticket-first-due-preview');
  const bhEl = document.getElementById('ticket-preview-business-hours');
  const outAlert = document.getElementById('ticket-out-of-hours-alert');
  const outExplanation = document.getElementById('ticket-out-of-hours-explanation');

  if (finalEl) finalEl.textContent = formatDateTimeBR(dueFinal.toISOString());
  if (firstEl) firstEl.textContent = formatDateTimeBR(dueFirst.toISOString());
  if (bhEl) {
    const daysLabel = (contract.businessDays || '1,2,3,4,5') === '1,2,3,4,5,6' ? 'Seg a Sáb' : (contract.businessDays || '').length > 10 ? 'Todos os dias' : 'Seg a Sex';
    const lunchInfo = contract.lunchBreakEnabled !== false && contract.lunchStart ? ` (Almoço: ${contract.lunchStart} às ${contract.lunchEnd || '13:00'})` : '';
    bhEl.textContent = `${contract.businessHoursStart || '08:00'} às ${contract.businessHoursEnd || '18:00'} (${daysLabel}${lunchInfo})`;
  }

  const bhStatus = isCurrentTimeInBusinessHours(contract);
  if (outAlert && outExplanation) {
    if (bhStatus.isLunch) {
      outAlert.classList.remove('hidden');
      const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      outExplanation.innerHTML = `O suporte está em <strong>intervalo de almoço</strong> neste momento (${timeStr}). O relógio de SLA está <strong>pausado</strong> e só começará a correr às <strong>${bhStatus.lunchEndStr}</strong>. Primeira resposta até <strong>${formatDateTimeBR(dueFirst.toISOString())}</strong>.`;
    } else if (!bhStatus.isOpen) {
      outAlert.classList.remove('hidden');
      const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      outExplanation.innerHTML = `O suporte está fechado neste momento (${timeStr}). O relógio de SLA só começará a correr no próximo dia útil às <strong>${bhStatus.startStr}</strong>. Primeira resposta até <strong>${formatDateTimeBR(dueFirst.toISOString())}</strong>. O SLA <strong>NÃO</strong> estoura durante a noite ou fins de semana.`;
    } else {
      outAlert.classList.add('hidden');
    }
  }
}

function updateDuePreview() {
  updateTicketDuePreview();
}

function toggleQuickUserForm() {
  const box = document.getElementById('quick-user-box');
  box.classList.toggle('hidden');
}

async function saveQuickUser() {
  const name = document.getElementById('quick-user-name').value.trim();
  const dept = document.getElementById('quick-user-dept').value.trim();
  const email = document.getElementById('quick-user-email').value.trim();
  const password = document.getElementById('quick-user-pass').value.trim() || '123456';
  const selectedClientId = document.getElementById('ticket-client')?.value || '';

  if (!name || !dept || !email) {
    showToast('Preencha Nome, Setor e E-mail do solicitante.', 'error');
    return;
  }

  try {
    const newUser = await window.db.addUser({
      name,
      department: dept,
      email,
      password,
      role: 'Solicitante',
      accessRole: 'USER',
      clientId: selectedClientId,
      isVip: false
    });
    const users = window.db.getUsers();
    const userSelect = document.getElementById('ticket-user');
    userSelect.innerHTML = users
      .map((u) => {
        const cliName = getClientNameById(u.clientId);
        return `<option value="${u.id}">${escapeHtml(u.name)} — ${escapeHtml(u.department)}${
          cliName ? ' (' + escapeHtml(cliName) + ')' : ''
        }${u.isVip ? ' ★ VIP' : ''}</option>`;
      })
      .join('');
    userSelect.value = newUser.id;

    document.getElementById('quick-user-name').value = '';
    document.getElementById('quick-user-dept').value = '';
    document.getElementById('quick-user-email').value = '';
    document.getElementById('quick-user-box').classList.add('hidden');
    showToast(`Usuário ${newUser.name} salvo no banco e selecionado!`);
    updateHeaderAndSidebarStats();
    populateFilterDropdowns();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleCreateTicket(e) {
  e.preventDefault();
  const session = window.db.getSession();
  const role = session?.role || 'USER';
  const userId =
    role === 'USER' ? session.userId : document.getElementById('ticket-user').value;
  const clientId = document.getElementById('ticket-client')?.value || '';
  const problemTypeId = document.getElementById('ticket-problem').value;
  const slaHours = Number(document.getElementById('ticket-sla').value);
  const firstResponseSlaHours = Number(document.getElementById('ticket-first-response-sla')?.value) || 1.0;
  const priority = document.getElementById('ticket-priority').value;

  // Equipamento: selecionado ou cadastrado
  let equipmentId = '';
  let newEquipment = null;
  if (isTicketEquipCreateMode) {
    const eqSerial = (document.getElementById('ticket-new-equip-serial')?.value || '').trim().toUpperCase();
    const eqName = (document.getElementById('ticket-new-equip-name')?.value || '').trim();
    const eqType = document.getElementById('ticket-new-equip-type')?.value || 'Desktop';
    if (eqSerial) {
      newEquipment = {
        name: eqName || `${eqType} ${eqSerial}`,
        type: eqType,
        serialNumber: eqSerial,
        clientId,
        userId
      };
    }
  } else {
    equipmentId = (document.getElementById('ticket-equipment-select')?.value || '').trim();
  }

  // Todos os chamados abertos por usuários ou técnicos vão para o Administrador direcionar ou atender
  const technician =
    role === 'ADMIN'
      ? document.getElementById('ticket-tech').value.trim() || 'Aguardando Direcionamento (Admin)'
      : 'Aguardando Direcionamento (Admin)';
  const title = document.getElementById('ticket-title').value;
  const description = document.getElementById('ticket-desc').value;

  if (!userId) {
    showToast('Cadastre ou selecione o usuário solicitante.', 'error');
    return;
  }
  if (!problemTypeId) {
    showToast('Selecione o tipo de problema.', 'error');
    return;
  }

  try {
    const contract = window.db.getContract() || {};
    const dueFinal = window.db.calculateBusinessDue(new Date(), slaHours, contract);
    const dueFirst = window.db.calculateBusinessDue(new Date(), firstResponseSlaHours, contract);

    const created = await window.db.addTicket({
      userId,
      clientId,
      equipmentId,
      newEquipment,
      problemTypeId,
      slaHours,
      firstResponseSlaHours,
      dueAt: dueFinal.toISOString(),
      firstResponseDueAt: dueFirst.toISOString(),
      priority,
      technician,
      title,
      description
    });

    const equipNote = created.equipmentId
      ? ` • Equipamento vinculado: [${created.equipmentId}]`
      : '';

    await window.db.addTicketNote(
      created.id,
      session?.name || 'Solicitante',
      `📋 CHAMADO ABERTO NO SISTEMA — Protocolo ${created.id} registrado com SLA de Resolução de ${created.slaHours}h e SLA de 1ª Resposta de ${created.firstResponseSlaHours || 1}h (em horário útil)${equipNote}. Status: Aberto.`
    );

    if (technician && !isTicketAwaitingAdminTriage({ technician })) {
      await window.db.addTicketNote(
        created.id,
        `${session?.name || 'Administrador'} (Admin)`,
        `📥 Direcionado para atendimento de: ${technician}. Status mantido como Aberto (aguardando aceite/início do técnico).`
      );
    }

    closeNewTicketModal();
    refreshAllViews();
    showToast(
      `Chamado ${created.id} registrado com sucesso (Status: Aberto)!`
    );
  } catch (err) {
    showToast(err.message || 'Erro ao registrar chamado.', 'error');
  }
}

// ==========================================
// MODAL: DETALHES, DIRECIONAMENTO DO ADMIN & EDIÇÃO COMPLETA DO CHAMADO
// ==========================================
function openDetailModal(ticketId) {
  activeTicketId = ticketId;
  const session = window.db.getSession();
  const role = session?.role || 'USER';
  const isAdmin = role === 'ADMIN';
  const isTech = role === 'TECH';
  const tickets = window.db.getTickets();
  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) return;

  const users = window.db.getUsers();
  const clients = window.db.getClients();
  const problems = window.db.getProblemTypes();
  const contract = window.db.getContract() || {};

  const user = users.find((u) => u.id === ticket.userId) || {
    name: 'Usuário não encontrado',
    department: '--',
    email: '--',
    phone: '',
    clientId: ''
  };
  const effectiveClientId = ticket.clientId || user.clientId || '';
  const clientName = getClientNameById(effectiveClientId);

  const problem = problems.find((p) => p.id === ticket.problemTypeId) || {
    name: 'Geral',
    category: 'Suporte'
  };
  const sla = evaluateTicketSla(ticket);

  document.getElementById('detail-id').textContent = ticket.id;
  document.getElementById('detail-title').textContent = ticket.title;
  document.getElementById('detail-user-name').textContent = `${user.name} (${user.department})${
    clientName ? ' — ' + clientName : ''
  }`;
  document.getElementById('detail-user-meta').textContent = `${user.email}${
    user.phone ? ' • ' + user.phone : ''
  }`;

  // Equipamento Vinculado no Modal
  const equipObj = ticket.equipmentId ? window.db.getEquipmentById(ticket.equipmentId) : null;
  const equipContainer = document.getElementById('detail-equip-container');
  const btnViewHistory = document.getElementById('btn-view-ticket-equip-history');
  if (equipContainer) {
    if (equipObj) {
      equipContainer.innerHTML = `
        <div class="p-2 rounded-lg bg-white border border-slate-200">
          <div class="flex items-center gap-1.5 font-bold text-slate-800 text-xs">
            <i data-lucide="cpu" class="w-3.5 h-3.5 text-indigo-600"></i>
            <span>${escapeHtml(equipObj.name)}</span>
          </div>
          <div class="flex items-center gap-1.5 mt-0.5 text-[11px] text-slate-500">
            <span class="px-1.5 py-0.2 bg-slate-100 rounded font-mono text-[10px] text-slate-700 font-bold">${escapeHtml(equipObj.serialNumber)}</span>
            <span>• ${escapeHtml(equipObj.type)}</span>
          </div>
        </div>
      `;
      if (btnViewHistory) btnViewHistory.classList.remove('hidden');
    } else {
      equipContainer.innerHTML = `<span class="text-xs text-slate-400">Nenhum equipamento vinculado</span>`;
      if (btnViewHistory) btnViewHistory.classList.add('hidden');
    }
  }

  // SLAs Duplos (1ª Resposta e Resolução)
  const slaBadgeEl = document.getElementById('detail-sla-badge');
  if (slaBadgeEl) {
    slaBadgeEl.innerHTML = `
      <div class="space-y-1">
        <div class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${sla.firstResponse.badgeClass}">
          <i data-lucide="play" class="w-3 h-3"></i>
          <span>${escapeHtml(sla.firstResponse.label)}</span>
        </div>
        <div class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${sla.badgeClass}">
          <i data-lucide="${sla.icon || 'clock'}" class="w-3 h-3"></i>
          <span>Resolução: ${escapeHtml(sla.label)}</span>
        </div>
      </div>
    `;
  }

  const bhBadge = document.getElementById('detail-business-hours-badge');
  if (bhBadge) {
    const bhStatus = isCurrentTimeInBusinessHours(contract);
    if (bhStatus.isLunch) {
      bhBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300';
      bhBadge.textContent = `Pausa de Almoço (até ${bhStatus.lunchEndStr})`;
    } else if (bhStatus.isOpen) {
      bhBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800';
      bhBadge.textContent = 'Expediente Ativo';
    } else {
      bhBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300';
      bhBadge.textContent = 'Fora do Expediente (Pausado)';
    }
  }

  document.getElementById('detail-dates').textContent = `Aberto: ${formatDateTimeBR(
    ticket.createdAt
  )} | Limite Resolução: ${formatDateTimeBR(ticket.dueAt)}`;

  document.getElementById('detail-problem-name').textContent = `${problem.name} — ${problem.category}`;
  document.getElementById('detail-desc').textContent = ticket.description;

  // Exibe quadro de Problema Encontrado & Serviço Realizado (Somente Leitura) se já estiver preenchido
  const readonlyBox = document.getElementById('detail-resolution-readonly-box');
  const roProb = document.getElementById('detail-readonly-problem-found');
  const roServ = document.getElementById('detail-readonly-service-performed');
  if (readonlyBox && roProb && roServ) {
    if (ticket.problemFound || ticket.servicePerformed) {
      readonlyBox.classList.remove('hidden');
      roProb.textContent = ticket.problemFound || 'Não informado.';
      roServ.textContent = ticket.servicePerformed || 'Não informado.';
    } else {
      readonlyBox.classList.add('hidden');
    }
  }

  // Oculta formulário de edição completa por padrão ao abrir o modal
  const fullEditForm = document.getElementById('detail-admin-full-edit-form');
  if (fullEditForm) fullEditForm.classList.add('hidden');

  const toggleEditBtn = document.getElementById('btn-toggle-edit-ticket');
  if (toggleEditBtn) {
    if (isAdmin) toggleEditBtn.classList.remove('hidden');
    else toggleEditBtn.classList.add('hidden');
  }

  // Painel de Direcionamento do Administrador (Direcionar para Técnico ou Atender Eu Mesmo)
  const triageBox = document.getElementById('detail-admin-triage-box');
  const assignSelect = document.getElementById('detail-assign-select');
  if (triageBox && assignSelect) {
    if (isAdmin) {
      triageBox.classList.remove('hidden');
      const techs = users.filter((u) => (u.accessRole === 'TECH' || u.accessRole === 'ADMIN') && !u.isBlocked);
      const adminDisplayName = `${session.name || 'Administrador Geral'} (Admin)`;
      let htmlOpts = `<option value="${escapeHtml(adminDisplayName)}">Atender Eu Mesmo — ${escapeHtml(adminDisplayName)}</option>`;
      techs.forEach((t) => {
        const rLabel = t.accessRole === 'ADMIN' ? 'Admin' : 'Técnico';
        htmlOpts += `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)} — ${rLabel} (${escapeHtml(t.department)})</option>`;
      });
      htmlOpts += `<option value="Fila Técnica Geral">Liberar para Fila Técnica Geral (Qualquer Técnico)</option>`;
      assignSelect.innerHTML = htmlOpts;

      if (ticket.technician && !isTicketAwaitingAdminTriage(ticket)) {
        assignSelect.value = ticket.technician;
      }
    } else {
      triageBox.classList.add('hidden');
    }
  }

  // Preenche campos do Formulário de Edição Completa do Chamado (Admin)
  if (isAdmin) {
    const editUserSel = document.getElementById('edit-ticket-user');
    if (editUserSel) {
      editUserSel.innerHTML = users
        .map((u) => `<option value="${u.id}">${escapeHtml(u.name)} (${escapeHtml(u.department)})</option>`)
        .join('');
      editUserSel.value = ticket.userId;
    }
    const editClientSel = document.getElementById('edit-ticket-client');
    if (editClientSel) {
      editClientSel.innerHTML =
        `<option value="">Sem cliente específico</option>` +
        clients
          .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
          .join('');
      editClientSel.value = effectiveClientId;
    }
    const editProbSel = document.getElementById('edit-ticket-problem');
    if (editProbSel) {
      editProbSel.innerHTML = problems
        .map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (SLA: ${p.defaultSlaHours}h)</option>`)
        .join('');
      editProbSel.value = ticket.problemTypeId;
    }
    document.getElementById('edit-ticket-sla').value = ticket.slaHours;
    document.getElementById('edit-ticket-priority').value = ticket.priority;
    document.getElementById('edit-ticket-title').value = ticket.title;
    document.getElementById('edit-ticket-desc').value = ticket.description;
  }

  // Exibe formulário de execução e finalização (status, técnico, horas, problema encontrado e serviço realizado) para Admin e Técnico
  const adminForm = document.getElementById('detail-admin-form');
  const deleteBtn = document.getElementById('btn-delete-ticket');
  if (isAdmin || isTech) {
    adminForm.classList.remove('hidden');
    document.getElementById('detail-status').value = ticket.status;
    document.getElementById('detail-tech').value = ticket.technician;
    document.getElementById('detail-hours').value = ticket.hoursSpent || 0;

    const probFoundEl = document.getElementById('detail-problem-found');
    const servPerfEl = document.getElementById('detail-service-performed');
    if (probFoundEl) probFoundEl.value = ticket.problemFound || '';
    if (servPerfEl) servPerfEl.value = ticket.servicePerformed || '';

    pendingTicketSolutionPdfs = [];
    const ticketPdfInput = document.getElementById('detail-solution-pdf-input');
    if (ticketPdfInput) ticketPdfInput.value = '';
    renderPendingTicketSolutionPdfs();

    // Renderiza a correlação inteligente de soluções anteriores
    renderCorrelatedSolutions(ticket);

    // Técnico não pode alterar o responsável para outro técnico se não for Admin
    document.getElementById('detail-tech').readOnly = !isAdmin;

    // Apenas Admin pode excluir chamados
    if (deleteBtn) {
      if (isAdmin) deleteBtn.classList.remove('hidden');
      else deleteBtn.classList.add('hidden');
    }
  } else {
    adminForm.classList.add('hidden');
  }

  updateDetailModalTimelineAndAccept(ticket);
  renderTicketNotes(ticket);
  document.getElementById('modal-ticket-detail').classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function handleViewActiveTicketEquipHistory() {
  const tickets = window.db.getTickets();
  const ticket = tickets.find((t) => t.id === activeTicketId);
  if (ticket && ticket.equipmentId) {
    openEquipmentHistory(ticket.equipmentId);
  }
}

// ==========================================
// CORRELAÇÃO INTELIGENTE DE SOLUÇÕES & ATENDIMENTOS ANTERIORES
// ==========================================
let activeCorrelatedMatches = [];

function renderCorrelatedSolutions(ticket) {
  const container = document.getElementById('detail-correlated-list');
  const countBadge = document.getElementById('detail-correlated-count-badge');
  if (!container || !countBadge) return;

  const allSolutions = window.db.getSolutions();
  const allTickets = window.db.getTickets();
  const equipObj = ticket.equipmentId ? window.db.getEquipmentById(ticket.equipmentId) : null;

  const matches = [];

  // 1. Busca chamados anteriores finalizados com laudo
  allTickets.forEach((t) => {
    if (t.id === ticket.id) return;
    if (t.status !== 'Resolvido') return;
    if (!t.problemFound && !t.servicePerformed) return;

    let correlationType = null;
    let badgeLabel = '';

    if (ticket.equipmentId && t.equipmentId === ticket.equipmentId) {
      correlationType = 'EQUIPMENT';
      badgeLabel = `Mesmo Ativo (${equipObj?.serialNumber || 'SN'})`;
    } else if (t.problemTypeId === ticket.problemTypeId) {
      correlationType = 'PROBLEM_TYPE';
      badgeLabel = 'Mesmo Problema';
    }

    if (correlationType) {
      matches.push({
        ticketId: t.id,
        title: t.title,
        problemFound: t.problemFound,
        servicePerformed: t.servicePerformed,
        technician: t.technician,
        resolvedAt: t.resolvedAt || t.createdAt,
        type: correlationType,
        badgeLabel
      });
    }
  });

  // 2. Busca no banco de soluções catalogadas
  allSolutions.forEach((s) => {
    if (s.ticketId === ticket.id) return;
    if (matches.some((m) => m.ticketId === s.ticketId)) return;
    if (s.problemTypeId === ticket.problemTypeId) {
      matches.push({
        ticketId: s.ticketId || '',
        title: s.title,
        problemFound: s.problemFound,
        servicePerformed: s.servicePerformed,
        technician: s.technician,
        resolvedAt: s.createdAt,
        type: 'PROBLEM_TYPE',
        badgeLabel: 'Solução Catalogada'
      });
    }
  });

  // Prioriza soluções do mesmo equipamento
  matches.sort((a, b) => {
    if (a.type === 'EQUIPMENT' && b.type !== 'EQUIPMENT') return -1;
    if (b.type === 'EQUIPMENT' && a.type !== 'EQUIPMENT') return 1;
    return new Date(b.resolvedAt) - new Date(a.resolvedAt);
  });

  activeCorrelatedMatches = matches;

  if (matches.length === 0) {
    countBadge.textContent = 'Sem histórico anterior';
    countBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500 border border-slate-200';
    container.innerHTML = `
      <div class="p-3 bg-white/80 rounded-lg border border-slate-200 text-slate-500 text-center">
        <p class="text-xs">Nenhum atendimento anterior registrado para este equipamento ou categoria de problema.</p>
        <p class="text-[11px] text-slate-400 mt-0.5">Ao concluir este atendimento, o diagnóstico e serviço serão automaticamente correlacionados para os próximos chamados.</p>
      </div>
    `;
    return;
  }

  countBadge.textContent = `${matches.length} correlacionado(s)`;
  countBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300';

  container.innerHTML = matches.slice(0, 3).map((m, idx) => `
    <div class="p-3 rounded-xl bg-white border border-amber-200 shadow-2xs space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${
            m.type === 'EQUIPMENT' ? 'bg-purple-100 text-purple-900 border border-purple-200' : 'bg-sky-100 text-sky-900 border border-sky-200'
          }">
            ${escapeHtml(m.badgeLabel)}
          </span>
          <span class="font-bold text-slate-800">${m.ticketId ? escapeHtml(m.ticketId) + ' — ' : ''}${escapeHtml(m.title)}</span>
        </div>
        <button
          type="button"
          onclick="applyCorrelatedSolutionToActiveTicket(${idx})"
          class="px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold text-[11px] transition-colors cursor-pointer shadow-xs"
        >
          Copiar Laudo para o Chamado
        </button>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
        <div class="p-2 rounded-lg bg-amber-50/70 border border-amber-100">
          <span class="font-bold text-amber-950 block text-[10px] uppercase">Problema Encontrado:</span>
          <p class="text-slate-700 mt-0.5 whitespace-pre-line">${escapeHtml(m.problemFound || 'Não informado')}</p>
        </div>
        <div class="p-2 rounded-lg bg-emerald-50/70 border border-emerald-100">
          <span class="font-bold text-emerald-950 block text-[10px] uppercase">Serviço Realizado:</span>
          <p class="text-slate-700 mt-0.5 whitespace-pre-line">${escapeHtml(m.servicePerformed || 'Não informado')}</p>
        </div>
      </div>
      <div class="text-[10px] text-slate-400">
        Atendido por <strong>${escapeHtml(m.technician || 'Equipe Técnica')}</strong> em ${formatDateTimeBR(m.resolvedAt)}
      </div>
    </div>
  `).join('');
}

function applyCorrelatedSolutionToActiveTicket(idx) {
  if (!activeCorrelatedMatches || !activeCorrelatedMatches[idx]) return;
  const item = activeCorrelatedMatches[idx];

  const probEl = document.getElementById('detail-problem-found');
  const servEl = document.getElementById('detail-service-performed');

  if (probEl) probEl.value = item.problemFound || '';
  if (servEl) servEl.value = item.servicePerformed || '';

  showToast(`Laudo anterior copiado para os campos de Diagnóstico e Serviço!`, 'success');
}

/**
 * Atualiza os marcos da Linha do Tempo e o Card de Aceite do Técnico no modal
 */
function updateDetailModalTimelineAndAccept(ticket) {
  if (!ticket) return;
  const session = window.db.getSession();
  const role = session?.role || 'USER';
  const isAdmin = role === 'ADMIN';
  const isTech = role === 'TECH';
  const users = window.db.getUsers();
  const user = users.find((u) => u.id === ticket.userId) || { name: 'Solicitante' };

  const isAssigned = ticket.technician && !isTicketAwaitingAdminTriage(ticket);

  const stepCreatedDate = document.getElementById('step-created-date');
  const stepCreatedBy = document.getElementById('step-created-by');
  const stepAssignedDate = document.getElementById('step-assigned-date');
  const stepAssignedTech = document.getElementById('step-assigned-tech');
  const stepStartedDate = document.getElementById('step-started-date');
  const stepStartedStatus = document.getElementById('step-started-status');
  const stepResolvedDate = document.getElementById('step-resolved-date');
  const stepResolvedStatus = document.getElementById('step-resolved-status');
  const lifecycleBadge = document.getElementById('detail-lifecycle-status-badge');

  if (stepCreatedDate) stepCreatedDate.textContent = formatDateTimeBR(ticket.createdAt);
  if (stepCreatedBy) stepCreatedBy.textContent = user.name || 'Solicitante';

  if (stepAssignedDate) {
    stepAssignedDate.textContent = isAssigned ? formatDateTimeBR(ticket.assignedAt || ticket.createdAt) : 'Pendente Triagem';
  }
  if (stepAssignedTech) {
    stepAssignedTech.textContent = isAssigned ? ticket.technician : 'Aguardando Admin';
  }

  if (stepStartedDate) {
    stepStartedDate.textContent = ticket.startedAt ? formatDateTimeBR(ticket.startedAt) : '--';
  }
  if (stepStartedStatus) {
    stepStartedStatus.textContent = ticket.startedAt
      ? 'Atendimento Iniciado'
      : (isAssigned ? 'Aguardando Aceite' : 'Não Iniciado');
  }

  if (stepResolvedDate) {
    stepResolvedDate.textContent = ticket.resolvedAt ? formatDateTimeBR(ticket.resolvedAt) : '--';
  }
  if (stepResolvedStatus) {
    stepResolvedStatus.textContent = ticket.status === 'Resolvido' ? 'Resolvido & Concluído' : 'Pendente';
  }

  // Estilização das caixas da Linha do Tempo
  const boxCreated = document.getElementById('step-created-box');
  const boxAssigned = document.getElementById('step-assigned-box');
  const boxStarted = document.getElementById('step-started-box');
  const boxResolved = document.getElementById('step-resolved-box');

  if (boxCreated) boxCreated.className = 'p-3 rounded-lg bg-indigo-50/70 border border-indigo-200';
  if (boxAssigned) {
    boxAssigned.className = isAssigned
      ? 'p-3 rounded-lg bg-amber-50/80 border border-amber-300'
      : 'p-3 rounded-lg bg-slate-50 border border-slate-200 opacity-60';
  }
  if (boxStarted) {
    boxStarted.className = ticket.startedAt
      ? 'p-3 rounded-lg bg-emerald-50/80 border border-emerald-300'
      : 'p-3 rounded-lg bg-slate-50 border border-slate-200 opacity-60';
  }
  if (boxResolved) {
    boxResolved.className = ticket.status === 'Resolvido'
      ? 'p-3 rounded-lg bg-emerald-100 text-emerald-950 border border-emerald-400 font-bold'
      : 'p-3 rounded-lg bg-slate-50 border border-slate-200 opacity-60';
  }

  if (lifecycleBadge) {
    if (ticket.status === 'Resolvido') {
      lifecycleBadge.textContent = 'Etapa 4/4: Resolvido';
      lifecycleBadge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300';
    } else if (ticket.status === 'Em Atendimento' || ticket.startedAt) {
      lifecycleBadge.textContent = 'Etapa 3/4: Em Atendimento';
      lifecycleBadge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-indigo-100 text-indigo-800 border border-indigo-300';
    } else if (isAssigned) {
      lifecycleBadge.textContent = 'Etapa 2/4: Aguardando Aceite do Técnico';
      lifecycleBadge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300';
    } else {
      lifecycleBadge.textContent = 'Etapa 1/4: Aberto (Triagem Admin)';
      lifecycleBadge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-sky-100 text-sky-800 border border-sky-300';
    }
  }

  // Painel de Aceite do Técnico: visível quando status é 'Aberto' e já foi direcionado a um técnico ou fila
  const acceptBox = document.getElementById('detail-tech-accept-box');
  const acceptMeta = document.getElementById('detail-accept-meta');
  const canAccept = (isAdmin || isTech) && ticket.status === 'Aberto' && isAssigned;
  if (acceptBox) {
    if (canAccept) {
      acceptBox.classList.remove('hidden');
      if (acceptMeta) {
        acceptMeta.innerHTML = `Chamado recebido para: <strong>${escapeHtml(ticket.technician)}</strong> em <strong>${formatDateTimeBR(ticket.assignedAt || ticket.createdAt)}</strong>.<br>Clique no botão ao lado para dar o aceite, registrar o horário de início e passar o status para "Em Atendimento".`;
      }
    } else {
      acceptBox.classList.add('hidden');
    }
  }
}

function applySolutionToTicketForm() {
  const picker = document.getElementById('detail-solution-picker');
  if (!picker || !picker.value) return;
  const sol = window.db.getSolutions().find((s) => s.id === picker.value);
  if (!sol) return;

  const probFoundEl = document.getElementById('detail-problem-found');
  const servPerfEl = document.getElementById('detail-service-performed');
  if (probFoundEl) probFoundEl.value = sol.problemFound || '';
  if (servPerfEl) servPerfEl.value = sol.servicePerformed || '';

  showToast(`Solução "${sol.title}" carregada nos campos de atendimento!`, 'info');
}

function toggleAdminFullTicketEdit() {
  const form = document.getElementById('detail-admin-full-edit-form');
  if (!form) return;
  form.classList.toggle('hidden');
}

async function handleSaveFullTicketEdit(e) {
  e.preventDefault();
  if (!activeTicketId) return;

  const userId = document.getElementById('edit-ticket-user').value;
  const clientId = document.getElementById('edit-ticket-client')?.value || '';
  const problemTypeId = document.getElementById('edit-ticket-problem').value;
  const slaHours = Number(document.getElementById('edit-ticket-sla').value) || 4;
  const priority = document.getElementById('edit-ticket-priority').value;
  const title = document.getElementById('edit-ticket-title').value.trim();
  const description = document.getElementById('edit-ticket-desc').value.trim();

  await window.db.updateTicket(activeTicketId, {
    userId,
    clientId,
    problemTypeId,
    slaHours,
    priority,
    title,
    description
  });

  openDetailModal(activeTicketId);
  refreshAllViews();
  showToast(`Dados do chamado ${activeTicketId} editados com sucesso pelo Administrador!`);
}

async function handleAdminSelfAttend() {
  if (!activeTicketId) return;
  const session = window.db.getSession();
  const adminName = `${session?.name || 'Administrador Geral'} (Admin)`;
  const ticket = window.db.getTickets().find((t) => t.id === activeTicketId);
  const nowIso = new Date().toISOString();

  // Status permanece como 'Aberto' para que o atendimento seja formalmente iniciado pelo botão Iniciar
  const newStatus = ticket?.status === 'Resolvido' ? 'Resolvido' : 'Aberto';

  await window.db.updateTicket(activeTicketId, {
    technician: adminName,
    assignedAt: nowIso,
    status: newStatus
  });
  await window.db.addTicketNote(
    activeTicketId,
    adminName,
    `📥 Administrador assumiu a responsabilidade pelo chamado em ${formatDateTimeBR(nowIso)}. Status: Aberto (aguardando aceite/início de atendimento).`
  );

  openDetailModal(activeTicketId);
  refreshAllViews();
  showToast(`Chamado ${activeTicketId} atribuído a você (Status: Aberto). Clique em "Iniciar Atendimento" para começar!`);
}

async function handleAdminAssignToTech() {
  if (!activeTicketId) return;
  const targetTech = document.getElementById('detail-assign-select')?.value;
  if (!targetTech) return;

  const session = window.db.getSession();
  const ticket = window.db.getTickets().find((t) => t.id === activeTicketId);
  const nowIso = new Date().toISOString();

  // O status permanece como 'Aberto' para que o técnico dê o aceite e inicie o atendimento!
  const newStatus = ticket?.status === 'Resolvido' ? 'Resolvido' : 'Aberto';

  await window.db.updateTicket(activeTicketId, {
    technician: targetTech,
    assignedAt: nowIso,
    status: newStatus
  });
  await window.db.addTicketNote(
    activeTicketId,
    `${session?.name || 'Administrador'} (Admin)`,
    `📥 Chamado direcionado pelo Administrador para: ${targetTech} em ${formatDateTimeBR(nowIso)}. Status mantido como Aberto (aguardando aceite e início do atendimento).`
  );

  openDetailModal(activeTicketId);
  refreshAllViews();
  showToast(`Chamado ${activeTicketId} direcionado para ${targetTech} (Status mantido como Aberto)!`);
}

/**
 * Aceita o chamado ativo no modal e inicia o atendimento técnico
 */
async function handleAcceptAndStartActiveTicket() {
  if (!activeTicketId) return;
  await handleAcceptAndStartTicket(activeTicketId);
}

/**
 * Aceita o chamado e registra o início oficial do atendimento técnico
 */
async function handleAcceptAndStartTicket(ticketId) {
  const session = window.db.getSession();
  if (!session) return;
  const ticket = window.db.getTickets().find((t) => t.id === ticketId);
  if (!ticket) return;

  const nowIso = new Date().toISOString();
  let assignedTech = ticket.technician;
  if (!assignedTech || isTicketAwaitingAdminTriage(ticket) || assignedTech === 'Fila Técnica Geral') {
    assignedTech = session.name || 'Técnico Responsável';
  }

  await window.db.updateTicket(ticketId, {
    status: 'Em Atendimento',
    technician: assignedTech,
    startedAt: nowIso
  });

  const roleTag = session.role === 'ADMIN' ? 'Admin' : 'Técnico';
  const author = `${session.name || assignedTech} (${roleTag})`;
  await window.db.addTicketNote(
    ticketId,
    author,
    `▶️ ACEITE TÉCNICO & INÍCIO DE ATENDIMENTO — Atendimento iniciado oficialmente em ${formatDateTimeBR(nowIso)}.`
  );

  if (activeTicketId === ticketId) {
    openDetailModal(ticketId);
  }
  refreshAllViews();
  showToast(`✅ Chamado ${ticketId} aceito! Atendimento iniciado e status alterado para Em Atendimento.`);
}

function renderTicketNotes(ticket) {
  const list = document.getElementById('detail-notes-list');
  if (!ticket.notes || ticket.notes.length === 0) {
    list.innerHTML = `<p class="text-xs text-slate-400 italic py-2">Nenhuma interação registrada neste chamado até o momento.</p>`;
    return;
  }
  list.innerHTML = ticket.notes
    .map(
      (n) => `
      <div class="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs">
        <div class="flex justify-between font-semibold text-slate-700 mb-1">
          <span>${escapeHtml(n.author)}</span>
          <span class="text-slate-400 font-normal">${formatDateTimeBR(n.createdAt)}</span>
        </div>
        <p class="text-slate-600">${escapeHtml(n.text)}</p>
      </div>
    `
    )
    .join('');
}

function closeDetailModal() {
  activeTicketId = null;
  document.getElementById('modal-ticket-detail').classList.add('hidden');
}

async function handleUpdateTicketDetail(e) {
  e.preventDefault();
  if (!activeTicketId) return;

  const status = document.getElementById('detail-status').value;
  const technician =
    document.getElementById('detail-tech').value.trim() || 'Aguardando Direcionamento (Admin)';
  const hoursSpent = Number(document.getElementById('detail-hours').value) || 0;
  const problemFound = document.getElementById('detail-problem-found')?.value.trim() || '';
  const servicePerformed = document.getElementById('detail-service-performed')?.value.trim() || '';

  if (status === 'Resolvido' && (!problemFound || !servicePerformed)) {
    showToast(
      'Para marcar como Resolvido, informe o "Problema Encontrado" e o "Serviço Realizado".',
      'error'
    );
    return;
  }

  await window.db.updateTicket(activeTicketId, {
    status,
    technician,
    hoursSpent,
    problemFound,
    servicePerformed,
    solutionAttachments: pendingTicketSolutionPdfs
  });
  pendingTicketSolutionPdfs = [];
  openDetailModal(activeTicketId);
  refreshAllViews();
  showToast(
    status === 'Resolvido'
      ? `Chamado ${activeTicketId} atualizado e salvo no Banco de Soluções!`
      : `Andamento do chamado ${activeTicketId} salvo no banco de dados!`
  );
}

async function handleFinalizeTicket() {
  if (!activeTicketId) return;
  const session = window.db.getSession();
  const problemFound = document.getElementById('detail-problem-found')?.value.trim() || '';
  const servicePerformed = document.getElementById('detail-service-performed')?.value.trim() || '';
  const hoursSpent = Number(document.getElementById('detail-hours')?.value) || 0;
  let technician = document.getElementById('detail-tech')?.value.trim() || '';

  if (!problemFound || !servicePerformed) {
    showToast(
      'Preencha os campos "Problema Encontrado" e "Serviço Realizado" antes de finalizar o chamado!',
      'error'
    );
    if (!problemFound) document.getElementById('detail-problem-found')?.focus();
    else document.getElementById('detail-service-performed')?.focus();
    return;
  }

  if (!technician || isTicketAwaitingAdminTriage({ technician })) {
    technician = session?.name || 'Técnico Responsável';
  }

  document.getElementById('detail-status').value = 'Resolvido';

  await window.db.updateTicket(activeTicketId, {
    status: 'Resolvido',
    technician,
    hoursSpent,
    problemFound,
    servicePerformed,
    solutionAttachments: pendingTicketSolutionPdfs
  });
  pendingTicketSolutionPdfs = [];

  const roleTag = session?.role === 'ADMIN' ? 'Admin' : 'Técnico';
  const author = `${session?.name || technician} (${roleTag})`;
  await window.db.addTicketNote(
    activeTicketId,
    author,
    `✅ CHAMADO FINALIZADO — Problema Encontrado: ${problemFound} | Serviço Realizado: ${servicePerformed}`
  );

  openDetailModal(activeTicketId);
  refreshAllViews();
  showToast(
    `Chamado ${activeTicketId} finalizado com sucesso! Solução catalogada automaticamente no Banco de Soluções.`
  );
}

async function handleAddNote(e) {
  e.preventDefault();
  if (!activeTicketId) return;
  const input = document.getElementById('detail-new-note');
  const text = input.value.trim();
  if (!text) return;

  const session = window.db.getSession();
  const roleTag =
    session?.role === 'ADMIN'
      ? 'Admin'
      : session?.role === 'TECH'
      ? 'Técnico'
      : 'Solicitante';
  const author = `${session?.name || 'Usuário'} (${roleTag})`;

  await window.db.addTicketNote(activeTicketId, author, text);
  input.value = '';

  const updated = window.db.getTickets().find((t) => t.id === activeTicketId);
  if (updated) renderTicketNotes(updated);
  showToast('Interação gravada no banco de dados!');
}

async function handleDeleteCurrentTicket() {
  if (!activeTicketId) return;
  await window.db.deleteTicket(activeTicketId);
  closeDetailModal();
  refreshAllViews();
  showToast('Chamado excluído do banco.', 'info');
}

// ==========================================
// ABA: BANCO DE SOLUÇÕES TÉCNICAS & UPLOAD DE DOCUMENTAÇÃO EM PDF
// ==========================================
let pendingManualSolutionPdfs = [];
let pendingTicketSolutionPdfs = [];
let targetSolutionIdForPdfUpload = null;
let currentPdfBlobUrl = null;

function formatFileSize(bytes) {
  const num = Number(bytes) || 0;
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(2)} MB`;
}

function readPdfFilesFromInput(fileList) {
  const files = Array.from(fileList || []);
  const promises = [];

  for (const file of files) {
    const isPdf =
      file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      showToast(`O arquivo "${file.name}" não é um PDF válido.`, 'error');
      continue;
    }
    if (file.size > 10 * 1024 * 1024) {
      showToast(`O arquivo "${file.name}" excede o limite de 10MB.`, 'error');
      continue;
    }

    promises.push(
      new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          resolve({
            id: 'pdf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
            name: file.name,
            size: file.size,
            dataUrl: reader.result,
            uploadedAt: new Date().toISOString()
          });
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      })
    );
  }

  return Promise.all(promises).then((list) => list.filter(Boolean));
}

async function handleManualSolutionPdfSelected(e) {
  const added = await readPdfFilesFromInput(e.target.files);
  if (added.length > 0) {
    pendingManualSolutionPdfs.push(...added);
    renderPendingManualSolutionPdfs();
    showToast(`${added.length} arquivo(s) PDF anexado(s) ao rascunho da solução!`);
  }
  e.target.value = '';
}

function removePendingManualPdf(attId) {
  pendingManualSolutionPdfs = pendingManualSolutionPdfs.filter((a) => a.id !== attId);
  renderPendingManualSolutionPdfs();
}

function renderPendingManualSolutionPdfs() {
  const box = document.getElementById('sol-pending-pdfs-list');
  if (!box) return;
  if (pendingManualSolutionPdfs.length === 0) {
    box.innerHTML = `<span class="text-[11px] text-slate-400 italic">Nenhum arquivo PDF selecionado ainda.</span>`;
    return;
  }
  box.innerHTML = pendingManualSolutionPdfs
    .map(
      (att) => `
      <span class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white border border-rose-200 text-xs font-medium text-slate-800 shadow-2xs">
        <span class="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-bold text-[10px]">PDF</span>
        <span class="truncate max-w-[200px]">${escapeHtml(att.name)}</span>
        <span class="text-[10px] text-slate-400">(${formatFileSize(att.size)})</span>
        <button type="button" onclick="removePendingManualPdf('${att.id}')" class="text-slate-400 hover:text-rose-600 font-bold cursor-pointer" title="Remover">✕</button>
      </span>
    `
    )
    .join('');
}

async function handleTicketSolutionPdfSelected(e) {
  const added = await readPdfFilesFromInput(e.target.files);
  if (added.length > 0) {
    pendingTicketSolutionPdfs.push(...added);
    renderPendingTicketSolutionPdfs();
    showToast(`${added.length} PDF(s) preparado(s) para o Banco de Soluções!`);
  }
  e.target.value = '';
}

function removePendingTicketPdf(attId) {
  pendingTicketSolutionPdfs = pendingTicketSolutionPdfs.filter((a) => a.id !== attId);
  renderPendingTicketSolutionPdfs();
}

function renderPendingTicketSolutionPdfs() {
  const box = document.getElementById('detail-pending-pdfs-list');
  if (!box) return;
  if (pendingTicketSolutionPdfs.length === 0) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = pendingTicketSolutionPdfs
    .map(
      (att) => `
      <span class="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg bg-rose-50/70 border border-rose-200 text-xs font-medium text-slate-800">
        <span class="px-1.5 py-0.5 rounded bg-rose-600 text-white font-bold text-[10px]">PDF</span>
        <span class="truncate max-w-[180px]">${escapeHtml(att.name)}</span>
        <span class="text-[10px] text-slate-500">(${formatFileSize(att.size)})</span>
        <button type="button" onclick="removePendingTicketPdf('${att.id}')" class="text-slate-400 hover:text-rose-600 font-bold cursor-pointer">✕</button>
      </span>
    `
    )
    .join('');
}

function triggerUploadPdfForSolution(solId) {
  targetSolutionIdForPdfUpload = solId;
  const input = document.getElementById('existing-solution-pdf-input');
  if (input) {
    input.value = '';
    input.click();
  }
}

async function handleExistingSolutionPdfSelected(e) {
  const solId = targetSolutionIdForPdfUpload;
  targetSolutionIdForPdfUpload = null;
  if (!solId) return;

  const added = await readPdfFilesFromInput(e.target.files);
  e.target.value = '';
  if (added.length === 0) return;

  for (const att of added) {
    await window.db.addSolutionAttachment(solId, att);
  }
  refreshAllViews();
  showToast(`${added.length} documento(s) PDF anexado(s) à solução com sucesso!`);
}

async function handleRemoveSolutionAttachment(solId, attId) {
  await window.db.removeSolutionAttachment(solId, attId);
  refreshAllViews();
  showToast('Arquivo PDF removido da solução.', 'info');
}

function dataUrlToBlobUrl(dataUrl) {
  try {
    const parts = dataUrl.split(',');
    const byteString = atob(parts[1]);
    const mimeMatch = parts[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/pdf';
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }
    const blob = new Blob([ab], { type: mime });
    return URL.createObjectURL(blob);
  } catch (err) {
    return dataUrl;
  }
}

function openPdfViewerModal(solId, attId) {
  const sol = window.db.getSolutions().find((s) => s.id === solId);
  if (!sol || !Array.isArray(sol.attachments)) return;
  const att = sol.attachments.find((a) => a.id === attId);
  if (!att || !att.dataUrl) return;

  if (currentPdfBlobUrl && currentPdfBlobUrl.startsWith('blob:')) {
    URL.revokeObjectURL(currentPdfBlobUrl);
  }
  currentPdfBlobUrl = dataUrlToBlobUrl(att.dataUrl);

  const titleEl = document.getElementById('pdf-viewer-title');
  const frameEl = document.getElementById('pdf-viewer-frame');
  const openTabEl = document.getElementById('pdf-viewer-open-tab');
  const downloadEl = document.getElementById('pdf-viewer-download');

  if (titleEl) titleEl.textContent = `${att.name} (${formatFileSize(att.size)})`;
  if (frameEl) frameEl.src = currentPdfBlobUrl;
  if (openTabEl) openTabEl.href = currentPdfBlobUrl;
  if (downloadEl) {
    downloadEl.href = currentPdfBlobUrl;
    downloadEl.download = att.name || 'documentacao-apoio.pdf';
  }

  document.getElementById('modal-pdf-viewer')?.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closePdfViewerModal() {
  const frameEl = document.getElementById('pdf-viewer-frame');
  if (frameEl) frameEl.src = '';
  if (currentPdfBlobUrl && currentPdfBlobUrl.startsWith('blob:')) {
    URL.revokeObjectURL(currentPdfBlobUrl);
    currentPdfBlobUrl = null;
  }
  document.getElementById('modal-pdf-viewer')?.classList.add('hidden');
}

function toggleManualSolutionForm() {
  const form = document.getElementById('form-new-solution');
  if (!form) return;
  form.classList.toggle('hidden');
  renderPendingManualSolutionPdfs();
}

async function handleCreateManualSolution(e) {
  e.preventDefault();
  const session = window.db.getSession();
  const title = document.getElementById('sol-title')?.value.trim() || '';
  const problemTypeId = document.getElementById('sol-problem-type')?.value || '';
  const problemFound = document.getElementById('sol-problem-found')?.value.trim() || '';
  const servicePerformed = document.getElementById('sol-service-performed')?.value.trim() || '';

  if (!title || !problemFound || !servicePerformed) {
    showToast('Preencha Título, Problema Encontrado e Serviço Realizado.', 'error');
    return;
  }

  try {
    await window.db.addSolution({
      ticketId: '',
      problemTypeId,
      title,
      problemFound,
      servicePerformed,
      technician: session?.name || 'Equipe Técnica',
      hoursSpent: 0,
      attachments: pendingManualSolutionPdfs
    });
    pendingManualSolutionPdfs = [];
    renderPendingManualSolutionPdfs();
    document.getElementById('form-new-solution')?.reset();
    document.getElementById('form-new-solution')?.classList.add('hidden');
    refreshAllViews();
    showToast('Solução técnica e documentação salvos no Banco de Soluções!');
  } catch (err) {
    showToast(err.message || 'Erro ao salvar solução.', 'error');
  }
}

function renderSolutionsBank() {
  const container = document.getElementById('solutions-list-container');
  if (!container) return;

  const solutions = window.db.getSolutions();
  const problems = window.db.getProblemTypes();
  const probMap = Object.fromEntries(problems.map((p) => [p.id, p]));
  const session = window.db.getSession();
  const isAdmin = session?.role === 'ADMIN';

  // Atualiza KPIs do Banco de Soluções
  const fromTicketsCount = solutions.filter((s) => Boolean(s.ticketId)).length;
  const distinctProbs = new Set(solutions.map((s) => s.problemTypeId).filter(Boolean)).size;

  const kpiTotal = document.getElementById('sol-kpi-total');
  const kpiFromTickets = document.getElementById('sol-kpi-from-tickets');
  const kpiCategories = document.getElementById('sol-kpi-categories');
  if (kpiTotal) kpiTotal.textContent = solutions.length;
  if (kpiFromTickets) kpiFromTickets.textContent = fromTicketsCount;
  if (kpiCategories) kpiCategories.textContent = distinctProbs;

  const search = (document.getElementById('sol-filter-search')?.value || '').toLowerCase().trim();
  const probFilter = document.getElementById('sol-filter-problem')?.value || 'ALL';

  const filtered = solutions.filter((s) => {
    if (probFilter !== 'ALL' && s.problemTypeId !== probFilter) return false;
    if (search) {
      const pName = probMap[s.problemTypeId]?.name || '';
      const pdfNames = (s.attachments || []).map((a) => a.name).join(' ');
      const haystack = [
        s.id,
        s.ticketId,
        s.title,
        s.problemFound,
        s.servicePerformed,
        s.technician,
        pName,
        pdfNames
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="p-10 rounded-xl bg-white border border-dashed border-slate-300 text-center space-y-2">
        <p class="font-bold text-slate-700 text-sm">Nenhuma solução encontrada no Banco de Soluções.</p>
        <p class="text-xs text-slate-500 max-w-lg mx-auto">
          Sempre que um técnico ou administrador preencher o <strong>Problema Encontrado</strong> e o <strong>Serviço Realizado</strong> e clicar em <strong>"Finalizar Chamado & Salvar Solução"</strong>, o atendimento será salvo automaticamente aqui!
        </p>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered
    .map((s) => {
      const prob = probMap[s.problemTypeId];
      const probBadge = prob
        ? `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">${escapeHtml(prob.name)} (${escapeHtml(prob.category)})</span>`
        : `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-600 border border-slate-200">Geral / Base Técnica</span>`;

      const originBadge = s.ticketId
        ? `<span onclick="openDetailModal('${escapeHtml(s.ticketId)}')" class="cursor-pointer hover:underline inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-emerald-100 text-emerald-800 border border-emerald-300 font-mono text-xs font-bold" title="Clique para abrir o chamado de origem">
             <i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i> Atendimento ${escapeHtml(s.ticketId)}
           </span>`
        : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200 text-[11px] font-semibold">
             Artigo Manual
           </span>`;

      const attachments = Array.isArray(s.attachments) ? s.attachments : [];
      const attachmentsHtml = `
        <div class="p-3.5 rounded-xl bg-slate-50 border border-slate-200/90 space-y-2.5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-[11px] font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
              <i data-lucide="file-text" class="w-3.5 h-3.5 text-rose-600"></i>
              Documentação de Apoio em PDF (${attachments.length})
            </span>
            <button
              type="button"
              onclick="triggerUploadPdfForSolution('${s.id}')"
              class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-50 hover:bg-rose-600 text-rose-700 hover:text-white border border-rose-200 text-xs font-semibold transition-colors cursor-pointer"
            >
              <i data-lucide="upload" class="w-3.5 h-3.5"></i>
              <span>+ Subir PDF de Apoio</span>
            </button>
          </div>
          ${
            attachments.length === 0
              ? `<p class="text-xs text-slate-400 italic">Nenhum PDF de apoio anexado a esta solução ainda. Clique em <strong>"+ Subir PDF de Apoio"</strong> para anexar manuais, diagramas ou procedimentos.</p>`
              : `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  ${attachments
                    .map(
                      (att) => `
                      <div class="p-2.5 rounded-lg bg-white border border-slate-200 flex items-center justify-between gap-2 shadow-2xs">
                        <div class="flex items-center gap-2.5 min-w-0">
                          <span class="px-2 py-1 rounded bg-rose-100 text-rose-700 font-bold text-[10px] uppercase shrink-0">PDF</span>
                          <div class="min-w-0">
                            <p class="text-xs font-semibold text-slate-800 truncate" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</p>
                            <p class="text-[10px] text-slate-400">${formatFileSize(att.size)}</p>
                          </div>
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onclick="openPdfViewerModal('${s.id}', '${att.id}')"
                            class="px-2.5 py-1 rounded bg-indigo-50 hover:bg-indigo-600 text-indigo-700 hover:text-white text-xs font-semibold transition-colors cursor-pointer"
                            title="Abrir e ler PDF"
                          >
                            Abrir PDF
                          </button>
                          <button
                            type="button"
                            onclick="handleRemoveSolutionAttachment('${s.id}', '${att.id}')"
                            class="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer"
                            title="Remover PDF"
                          >
                            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                          </button>
                        </div>
                      </div>
                    `
                    )
                    .join('')}
                </div>`
          }
        </div>
      `;

      return `
        <div class="bg-white rounded-xl border border-slate-200 shadow-xs p-5 space-y-3 hover:border-indigo-300 transition-colors">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                ${originBadge}
                ${probBadge}
                <span class="text-[11px] text-slate-400">Catalogado em ${formatDateTimeBR(s.createdAt)}</span>
              </div>
              <h5 class="text-base font-bold text-slate-900">${escapeHtml(s.title)}</h5>
            </div>

            <div class="flex items-center gap-2">
              <button type="button" onclick="triggerUploadPdfForSolution('${s.id}')" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-600 text-rose-700 hover:text-white border border-rose-200 text-xs font-semibold transition-colors cursor-pointer">
                <i data-lucide="file-up" class="w-3.5 h-3.5"></i>
                Anexar PDF
              </button>
              <button type="button" onclick="copySolutionText('${s.id}')" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-indigo-600 hover:text-white text-slate-700 text-xs font-semibold transition-colors cursor-pointer">
                <i data-lucide="copy" class="w-3.5 h-3.5"></i>
                Copiar Solução
              </button>
              ${
                isAdmin
                  ? `<button type="button" onclick="handleDeleteSolution('${s.id}')" class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-600 text-rose-700 hover:text-white border border-rose-200 text-xs font-semibold transition-colors cursor-pointer" title="Excluir do Banco de Soluções">
                       <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                     </button>`
                  : ''
              }
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
            <div class="p-3.5 rounded-xl bg-amber-50/60 border border-amber-200">
              <p class="text-[11px] font-bold uppercase tracking-wider text-amber-900 mb-1 flex items-center gap-1.5">
                <i data-lucide="search-check" class="w-3.5 h-3.5 text-amber-700"></i>
                Problema Encontrado (Diagnóstico)
              </p>
              <p class="text-xs text-slate-800 whitespace-pre-line leading-relaxed">${escapeHtml(s.problemFound)}</p>
            </div>

            <div class="p-3.5 rounded-xl bg-emerald-50/60 border border-emerald-200">
              <p class="text-[11px] font-bold uppercase tracking-wider text-emerald-900 mb-1 flex items-center gap-1.5">
                <i data-lucide="wrench" class="w-3.5 h-3.5 text-emerald-700"></i>
                Serviço Realizado (Solução Aplicada)
              </p>
              <p class="text-xs text-slate-800 whitespace-pre-line leading-relaxed">${escapeHtml(s.servicePerformed)}</p>
            </div>
          </div>

          ${attachmentsHtml}

          <div class="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between text-xs text-slate-500 gap-2">
            <span>Técnico Responsável: <strong class="text-slate-700">${escapeHtml(s.technician || 'Equipe Técnica')}</strong></span>
            ${
              Number(s.hoursSpent) > 0
                ? `<span>Tempo técnico no atendimento: <strong class="text-slate-700">${s.hoursSpent}h</strong></span>`
                : ''
            }
          </div>
        </div>
      `;
    })
    .join('');

  if (window.lucide) lucide.createIcons();
}

function copySolutionText(solId) {
  const sol = window.db.getSolutions().find((s) => s.id === solId);
  if (!sol) return;
  const text = `Solução Técnica: ${sol.title}\nProblema Encontrado: ${sol.problemFound}\nServiço Realizado: ${sol.servicePerformed}`;
  navigator.clipboard.writeText(text).then(() => {
    showToast('Diagnóstico e Serviço Realizado copiados para a área de transferência!');
  });
}

async function handleDeleteSolution(solId) {
  await window.db.deleteSolution(solId);
  refreshAllViews();
  showToast('Registro removido do Banco de Soluções.', 'info');
}

// ==========================================
// ABA: GERENCIAMENTO DE USUÁRIOS (CADASTRO, EDIÇÃO, BLOQUEIO, EXCLUSÃO, FOTO & CLIENTE)
// ==========================================
let pendingAdminUserAvatar = '';

function handleAdminUserAvatarSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    showToast('Escolha uma imagem de até 2MB.', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingAdminUserAvatar = reader.result;
    updateAdminUserFormAvatarPreview(pendingAdminUserAvatar);
  };
  reader.readAsDataURL(file);
}

function clearAdminUserAvatar() {
  pendingAdminUserAvatar = '';
  const fileInput = document.getElementById('user-avatar-file');
  if (fileInput) fileInput.value = '';
  updateAdminUserFormAvatarPreview('');
}

function updateAdminUserFormAvatarPreview(src) {
  const img = document.getElementById('user-form-avatar-preview');
  const fallback = document.getElementById('user-form-avatar-fallback');
  if (!img || !fallback) return;
  if (src) {
    img.src = src;
    img.classList.remove('hidden');
    fallback.classList.add('hidden');
  } else {
    img.src = '';
    img.classList.add('hidden');
    fallback.classList.remove('hidden');
  }
}

function onUserRoleSelectChange() {
  const role = document.getElementById('user-access-role')?.value || 'USER';
  const helper = document.getElementById('user-role-helper');
  if (!helper) return;

  const descriptions = {
    USER: 'Usuário Comum: Abre chamados (enviados ao Admin), vê apenas os seus chamados e seu relatório individual.',
    TECH: 'Técnico: Recebe os chamados direcionados pelo Admin, altera status, aponta horas e vê relatório técnico.',
    ADMIN: 'Administrador: Acesso total, recebe chamados para direcionar ou atender, gerencia usuários e vê relatório global.'
  };
  helper.textContent = descriptions[role] || descriptions.USER;
}

function onUserContractSelectChange() {
  const clientId = document.getElementById('user-client-id')?.value || '';
  const helper = document.getElementById('user-contract-helper');
  if (!helper) return;

  if (!clientId) {
    const totalClients = window.db.getClients().length;
    helper.innerHTML =
      totalClients === 0
        ? `Nenhum contrato cadastrado ainda. Clique em <strong>"+ Novo Contrato"</strong> acima para cadastrar uma empresa cliente.`
        : `Sem contrato específico vinculado (ideal para técnicos/administradores internos). Selecione uma empresa acima para vincular o usuário ao contrato.`;
    return;
  }

  const cli = window.db.getClients().find((c) => c.id === clientId);
  if (!cli) return;

  helper.innerHTML = `Faz parte do contrato: <strong>${escapeHtml(cli.name)}</strong> ${
    cli.contractNumber ? '(Nº ' + escapeHtml(cli.contractNumber) + ')' : ''
  } • Franquia: <strong>${cli.monthlyHoursQuota || 0}h/mês</strong> • Meta SLA: <strong>${
    cli.slaTargetPercent || 95
  }%</strong>`;
}

function renderUsers() {
  const users = window.db.getUsers();
  const clients = window.db.getClients();
  const tickets = window.db.getTickets();
  const tbody = document.getElementById('users-table-body');
  if (!tbody) return;

  const clientMap = Object.fromEntries(clients.map((c) => [c.id, c]));
  const blockedCount = users.filter((u) => u.isBlocked).length;
  document.getElementById('users-table-subtitle').textContent = `${users.length} cadastrado(s)${
    blockedCount > 0 ? ` • ${blockedCount} bloqueado(s)` : ''
  }`;

  if (users.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="py-10 text-center text-slate-400 text-xs">
          Nenhum usuário cadastrado. Utilize o formulário ao lado para cadastrar Administradores, Técnicos ou Usuários Comuns e selecionar de qual contrato fazem parte.
        </td>
      </tr>
    `;
    return;
  }

  const hierarchyMeta = {
    ADMIN: {
      badge: 'Administrador',
      cls: 'bg-purple-100 text-purple-800 border-purple-300',
      scope: 'Gestão Total + Triagem + Relatório Global'
    },
    TECH: {
      badge: 'Técnico de Suporte',
      cls: 'bg-sky-100 text-sky-800 border-sky-300',
      scope: 'Atendimento Direcionado + Relatório Técnico'
    },
    USER: {
      badge: 'Usuário Comum',
      cls: 'bg-emerald-100 text-emerald-800 border-emerald-300',
      scope: 'Meus Chamados + Relatório Individual'
    }
  };

  tbody.innerHTML = users
    .map((u) => {
      const accessRole = u.accessRole || 'USER';
      const meta = hierarchyMeta[accessRole] || hierarchyMeta.USER;
      const cli = clientMap[u.clientId];
      const count =
        accessRole === 'TECH'
          ? tickets.filter((t) => (t.technician || '').toLowerCase().includes((u.name || '').toLowerCase())).length
          : tickets.filter((t) => t.userId === u.id).length;

      const avatarHtml = u.avatar
        ? `<img src="${u.avatar}" alt="${escapeHtml(u.name)}" class="w-9 h-9 rounded-full object-cover border border-slate-200 shrink-0" />`
        : `<div class="w-9 h-9 rounded-full bg-indigo-50 text-indigo-700 font-bold text-xs flex items-center justify-center border border-indigo-200 shrink-0">${getInitials(u.name)}</div>`;

      const statusBadgeHtml = u.isBlocked
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-300">Bloqueado</span>`
        : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Ativo</span>`;

      const clientPill = cli
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-800 border border-indigo-200 text-[11px] font-semibold">Contrato: ${escapeHtml(cli.name)}${
            cli.contractNumber ? ' (' + escapeHtml(cli.contractNumber) + ')' : ''
          }</span>`
        : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200 text-[10px] font-medium">Equipe Interna / Sem Contrato</span>`;

      const pwdStatusHtml = u.mustChangePassword
        ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-bold">1º Acesso: Troca Obrigatória</span>`
        : `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-semibold">Senha Definitiva</span>`;

      return `
        <tr class="hover:bg-slate-50 ${u.isBlocked ? 'bg-rose-50/30 opacity-80' : ''}">
          <td class="py-3 px-4">
            <div class="flex items-center gap-2.5">
              ${avatarHtml}
              <div>
                <div class="flex items-center gap-1.5">
                  <span class="font-semibold text-slate-900 ${u.isBlocked ? 'line-through text-slate-500' : ''}">${escapeHtml(u.name)}</span>
                  ${
                    u.isVip
                      ? `<span class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold">VIP</span>`
                      : ''
                  }
                </div>
                <p class="text-xs text-slate-500">${escapeHtml(u.department)} ${u.role ? '• ' + escapeHtml(u.role) : ''}</p>
                <div class="mt-1">${clientPill}</div>
              </div>
            </div>
          </td>
          <td class="py-3 px-4">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${meta.cls}">
                ${meta.badge}
              </span>
              ${statusBadgeHtml}
            </div>
            <p class="text-[11px] text-slate-400 mt-1">${meta.scope}</p>
          </td>
          <td class="py-3 px-4 text-xs">
            <p class="font-medium text-slate-800">${escapeHtml(u.email)}</p>
            <p class="text-slate-400 mt-0.5">Senha: <code class="px-1.5 py-0.5 bg-slate-100 rounded font-mono text-slate-700">${escapeHtml(u.password || '123456')}</code></p>
            <div class="mt-1">${pwdStatusHtml}</div>
          </td>
          <td class="py-3 px-4 text-center">
            <span class="inline-flex items-center justify-center w-7 h-7 rounded-full bg-indigo-50 text-indigo-700 font-bold text-xs">${count}</span>
            <span class="block text-[10px] text-slate-400">${accessRole === 'TECH' ? 'atendidos' : 'abertos'}</span>
          </td>
          <td class="py-3 px-4 text-right">
            <div class="inline-flex flex-wrap items-center justify-end gap-1.5">
              <button onclick="startEditUser('${u.id}')" title="Editar dados e contrato deste usuário" class="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition-colors cursor-pointer">
                Editar
              </button>
              <button onclick="handleResetUserPassword('${u.id}')" title="Desbloquear / Resetar senha para 123456 e exigir troca obrigatória no próximo acesso" class="px-2.5 py-1 rounded bg-sky-100 hover:bg-sky-600 text-sky-800 hover:text-white text-xs font-semibold transition-colors cursor-pointer">
                Desbloquear Senha
              </button>
              <button onclick="handleToggleBlockUser('${u.id}')" title="${u.isBlocked ? 'Desbloquear acesso do usuário' : 'Bloquear acesso do usuário'}" class="px-2.5 py-1 rounded ${
                u.isBlocked
                  ? 'bg-emerald-100 hover:bg-emerald-600 text-emerald-800 hover:text-white'
                  : 'bg-amber-100 hover:bg-amber-600 text-amber-900 hover:text-white'
              } text-xs font-semibold transition-colors cursor-pointer">
                ${u.isBlocked ? 'Desbloquear' : 'Bloquear'}
              </button>
              <button onclick="loginAsUserQuick('${u.id}')" title="Testar acesso com este usuário" class="px-2.5 py-1 rounded bg-indigo-50 hover:bg-indigo-600 text-indigo-700 hover:text-white text-xs font-semibold transition-colors cursor-pointer">
                Testar
              </button>
              <button onclick="handleDeleteUser('${u.id}')" title="Excluir usuário" class="px-2 py-1 rounded text-rose-600 hover:bg-rose-50 text-xs font-semibold cursor-pointer">
                Excluir
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

function startEditUser(userId) {
  const user = window.db.getUsers().find((u) => u.id === userId);
  if (!user) return;

  populateFilterDropdowns();
  document.getElementById('edit-user-id').value = user.id;
  document.getElementById('user-access-role').value = user.accessRole || 'USER';
  const cliSel = document.getElementById('user-client-id');
  if (cliSel) cliSel.value = user.clientId || '';
  document.getElementById('user-name').value = user.name || '';
  document.getElementById('user-dept').value = user.department || '';
  document.getElementById('user-role').value = user.role || '';
  document.getElementById('user-email').value = user.email || '';
  document.getElementById('user-password').value = user.password || '123456';
  document.getElementById('user-phone').value = user.phone || '';
  document.getElementById('user-vip').checked = Boolean(user.isVip);
  document.getElementById('user-blocked').checked = Boolean(user.isBlocked);
  const mustChangeEl = document.getElementById('user-must-change-pwd');
  if (mustChangeEl) mustChangeEl.checked = Boolean(user.mustChangePassword);

  pendingAdminUserAvatar = user.avatar || '';
  updateAdminUserFormAvatarPreview(pendingAdminUserAvatar);
  onUserRoleSelectChange();
  onUserContractSelectChange();

  document.getElementById('user-form-title').innerHTML = `<i data-lucide="user-check" class="w-4 h-4 text-indigo-600"></i><span>Editando: ${escapeHtml(user.name)}</span>`;
  document.getElementById('btn-submit-user').textContent = 'Salvar Alterações do Usuário';
  document.getElementById('btn-cancel-user-edit').classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function cancelEditUser() {
  document.getElementById('form-new-user').reset();
  document.getElementById('edit-user-id').value = '';
  document.getElementById('user-password').value = '123456';
  document.getElementById('user-access-role').value = 'USER';
  const cliSel = document.getElementById('user-client-id');
  if (cliSel) cliSel.value = '';
  document.getElementById('user-blocked').checked = false;
  const mustChangeEl = document.getElementById('user-must-change-pwd');
  if (mustChangeEl) mustChangeEl.checked = true;
  clearAdminUserAvatar();
  onUserRoleSelectChange();
  onUserContractSelectChange();

  document.getElementById('user-form-title').innerHTML = `<i data-lucide="user-plus" class="w-4 h-4 text-indigo-600"></i><span>Cadastrar Usuário & Perfil</span>`;
  document.getElementById('btn-submit-user').textContent = 'Salvar Usuário no Banco';
  document.getElementById('btn-cancel-user-edit').classList.add('hidden');
  if (window.lucide) lucide.createIcons();
}

async function handleCreateUser(e) {
  e.preventDefault();
  const editId = document.getElementById('edit-user-id')?.value || '';
  const accessRole = document.getElementById('user-access-role')?.value || 'USER';
  const clientId = document.getElementById('user-client-id')?.value || '';
  const name = document.getElementById('user-name').value;
  const department = document.getElementById('user-dept').value;
  const role = document.getElementById('user-role').value;
  const email = document.getElementById('user-email').value;
  const password = document.getElementById('user-password').value;
  const phone = document.getElementById('user-phone').value;
  const isVip = document.getElementById('user-vip').checked;
  const isBlocked = document.getElementById('user-blocked').checked;
  const mustChangePassword = document.getElementById('user-must-change-pwd')
    ? document.getElementById('user-must-change-pwd').checked
    : true;

  try {
    if (editId) {
      await window.db.updateUser(editId, {
        name,
        department,
        role,
        accessRole,
        clientId,
        email,
        password,
        phone,
        isVip,
        isBlocked,
        mustChangePassword,
        avatar: pendingAdminUserAvatar
      });
      cancelEditUser();
      refreshAllViews();
      showToast('Dados, contrato e permissões do usuário atualizados com sucesso!');
    } else {
      await window.db.addUser({
        name,
        department,
        role,
        accessRole,
        clientId,
        email,
        password,
        phone,
        isVip,
        isBlocked,
        mustChangePassword,
        avatar: pendingAdminUserAvatar
      });
      cancelEditUser();
      refreshAllViews();
      showToast('Usuário salvo no banco com troca de senha configurada!');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleResetUserPassword(userId) {
  const user = window.db.getUsers().find((u) => u.id === userId);
  if (!user) return;
  try {
    await window.db.updateUser(userId, {
      password: '123456',
      isBlocked: false,
      mustChangePassword: true
    });
    refreshAllViews();
    showToast(
      `Senha de ${user.name} desbloqueada/redefinida para "123456" (troca obrigatória ativada no próximo login)!`
    );
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleToggleBlockUser(userId) {
  const user = window.db.getUsers().find((u) => u.id === userId);
  if (!user) return;
  const nextBlocked = !user.isBlocked;
  try {
    await window.db.updateUser(userId, { isBlocked: nextBlocked });
    refreshAllViews();
    showToast(
      nextBlocked
        ? `Acesso de ${user.name} foi BLOQUEADO.`
        : `Acesso de ${user.name} foi DESBLOQUEADO!`,
      nextBlocked ? 'info' : 'success'
    );
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleDeleteUser(id) {
  const user = window.db.getUsers().find((u) => u.id === id);
  await window.db.deleteUser(id);
  if (document.getElementById('edit-user-id')?.value === id) {
    cancelEditUser();
  }
  refreshAllViews();
  showToast(`Usuário ${user ? user.name : ''} excluído do banco.`, 'info');
}

// ==========================================
// ABA: CATÁLOGO DE PROBLEMAS & SLA
// ==========================================
function renderProblemTypes() {
  const problems = window.db.getProblemTypes();
  const tickets = window.db.getTickets();
  const container = document.getElementById('problems-list-container');
  if (!container) return;

  if (problems.length === 0) {
    container.innerHTML = `
      <div class="bg-white p-8 rounded-xl border border-slate-200 text-center text-slate-400 text-xs">
        Nenhum tipo de problema cadastrado. Cadastre ao lado os tipos de incidente e seus respectivos SLAs em horas.
      </div>
    `;
    return;
  }

  container.innerHTML = problems
    .map((p) => {
      const count = tickets.filter((t) => t.problemTypeId === p.id).length;
      return `
        <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-4">
          <div class="space-y-1 max-w-xl">
            <div class="flex items-center gap-2">
              <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                SLA: ${p.defaultSlaHours}h
              </span>
              <span class="text-xs font-semibold text-slate-400 uppercase">${escapeHtml(p.category)}</span>
              <span class="text-xs text-slate-500">• Prioridade ${escapeHtml(p.priority)}</span>
            </div>
            <h4 class="font-bold text-slate-900 text-sm">${escapeHtml(p.name)}</h4>
            <p class="text-xs text-slate-500">${escapeHtml(p.description || 'Sem descrição adicional.')}</p>
          </div>

          <div class="flex items-center gap-4">
            <div class="text-right">
              <span class="block text-sm font-bold text-slate-800">${count}</span>
              <span class="text-[11px] text-slate-400">chamados</span>
            </div>
            <button onclick="handleDeleteProblem('${p.id}')" class="text-xs text-rose-600 hover:text-rose-800 font-medium cursor-pointer">
              Excluir
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

async function handleCreateProblem(e) {
  e.preventDefault();
  const name = document.getElementById('prob-name').value;
  const category = document.getElementById('prob-category').value;
  const defaultSlaHours = Number(document.getElementById('prob-sla').value);
  const priority = document.getElementById('prob-priority').value;
  const description = document.getElementById('prob-desc').value;

  await window.db.addProblemType({ name, category, defaultSlaHours, priority, description });
  document.getElementById('form-new-problem').reset();
  document.getElementById('prob-sla').value = 4;
  refreshAllViews();
  showToast('Tipo de problema e SLA salvos no banco de dados!');
}

async function handleDeleteProblem(id) {
  await window.db.deleteProblemType(id);
  refreshAllViews();
  showToast('Tipo de problema removido do banco.', 'info');
}

// ==========================================
// ABA: RELATÓRIOS & DASHBOARD (POR NÍVEL DE HIERARQUIA & MÚLTIPLOS CLIENTES)
// ==========================================
function renderDashboard() {
  const session = window.db.getSession();
  const role = session?.role || 'USER';
  const contract = window.db.getContract();
  const clients = window.db.getClients();
  const allTickets = window.db.getTickets();
  const users = window.db.getUsers();
  const problems = window.db.getProblemTypes();

  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
  const selectedClientId =
    role === 'ADMIN' ? document.getElementById('dash-filter-client')?.value || 'ALL' : 'ALL';
  const selectedClientObj =
    selectedClientId !== 'ALL' ? clients.find((c) => c.id === selectedClientId) : null;

  // Filtra os chamados do relatório conforme a hierarquia (ADMIN = Tudo ou Cliente filtrado, TECH = Fila Técnica, USER = Próprios)
  let scopedTickets = getScopedTicketsForSession(session, allTickets);
  if (role === 'ADMIN' && selectedClientObj) {
    scopedTickets = scopedTickets.filter((t) => {
      const effCli = t.clientId || userMap[t.userId]?.clientId || '';
      return effCli === selectedClientObj.id;
    });
  }

  const scopeBadge = document.getElementById('report-scope-badge');
  const exportBtnLabel = document.getElementById('btn-export-csv-label');
  const card2Title = document.getElementById('dash-card2-title');
  const panel2Title = document.getElementById('dash-panel2-title');
  const techSection = document.getElementById('dash-tech-section');

  let activeQuota = Number(contract.monthlyHoursQuota) || 0;
  let activeSlaTarget = Number(contract.slaTargetPercent) || 95;

  if (role === 'ADMIN') {
    if (scopeBadge) {
      scopeBadge.textContent = selectedClientObj
        ? `Relatório por Cliente — ${selectedClientObj.name}`
        : 'Relatório Global Completo — Hierarquia: Administrador';
      scopeBadge.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider bg-purple-100 text-purple-800';
    }
    if (exportBtnLabel) exportBtnLabel.textContent = 'Exportar Relatório (CSV)';
    if (card2Title) card2Title.textContent = 'Consumo de Horas do Contrato';
    if (panel2Title) panel2Title.textContent = 'Chamados por Usuário / Empresa Cliente';
    if (techSection) techSection.classList.remove('hidden');

    if (selectedClientObj) {
      activeQuota = Number(selectedClientObj.monthlyHoursQuota) || 0;
      activeSlaTarget = Number(selectedClientObj.slaTargetPercent) || 95;
      document.getElementById('report-client-title').textContent = selectedClientObj.name;
      document.getElementById('report-contract-subtitle').textContent = `Contrato: ${
        selectedClientObj.contractNumber || '--'
      } • CNPJ: ${selectedClientObj.cnpj || '--'} • Gestor: ${selectedClientObj.managerName || '--'}`;
    } else if (clients.length > 0) {
      activeQuota = clients.reduce((acc, c) => acc + (Number(c.monthlyHoursQuota) || 0), 0);
      document.getElementById('report-client-title').textContent =
        clients.length === 1 ? clients[0].name : `Consolidado Geral (${clients.length} Clientes de Contrato)`;
      document.getElementById('report-contract-subtitle').textContent =
        'Visão consolidada de todas as empresas clientes, franquias de horas, solicitantes e técnicos.';
    } else {
      document.getElementById('report-client-title').textContent =
        contract.clientName || 'Relatório Geral de Contratos';
      document.getElementById('report-contract-subtitle').textContent =
        'Cadastre seus clientes de contrato fixo na aba Clientes & Contratos.';
    }
  } else if (role === 'TECH') {
    if (scopeBadge) {
      scopeBadge.textContent = `Relatório Operacional — Hierarquia: Técnico (${session.name})`;
      scopeBadge.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider bg-sky-100 text-sky-800';
    }
    if (exportBtnLabel) exportBtnLabel.textContent = 'Exportar Meus Atendimentos (CSV)';
    if (card2Title) card2Title.textContent = 'Horas Técnicas Apontadas por Você';
    if (panel2Title) panel2Title.textContent = 'Solicitantes Atendidos na Sua Fila';
    if (techSection) techSection.classList.add('hidden');

    document.getElementById('report-client-title').textContent = `Desempenho Técnico — ${session.name}`;
    document.getElementById('report-contract-subtitle').textContent = `Setor: ${
      session.department || 'Suporte Técnico'
    } • Métricas exclusivas dos chamados direcionados a você`;
  } else {
    // USER (Usuário Comum)
    const myUser = userMap[session.userId];
    const myClient = myUser?.clientId ? clients.find((c) => c.id === myUser.clientId) : null;
    if (myClient) {
      activeQuota = Number(myClient.monthlyHoursQuota) || 0;
      activeSlaTarget = Number(myClient.slaTargetPercent) || 95;
    }
    if (scopeBadge) {
      scopeBadge.textContent = `Relatório Individual — Hierarquia: Usuário Comum (${session.name})`;
      scopeBadge.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-800';
    }
    if (exportBtnLabel) exportBtnLabel.textContent = 'Exportar Meus Chamados (CSV)';
    if (card2Title) card2Title.textContent = 'Horas de Suporte nos Seus Chamados';
    if (panel2Title) panel2Title.textContent = 'Resumo Status dos Meus Chamados';
    if (techSection) techSection.classList.add('hidden');

    document.getElementById('report-client-title').textContent = `Meus Chamados — ${session.name}${
      myClient ? ' (' + myClient.name + ')' : ''
    }`;
    document.getElementById('report-contract-subtitle').textContent = `Departamento: ${
      session.department || 'Cliente'
    } • Histórico e cumprimento de SLA das solicitações abertas por você`;
  }

  // 1. Taxa de Cumprimento SLA no escopo
  const totalTickets = scopedTickets.length;
  const withinSlaCount = scopedTickets.filter((t) => evaluateTicketSla(t).metSla).length;
  const slaRate = totalTickets > 0 ? Math.round((withinSlaCount / totalTickets) * 100) : 100;

  document.getElementById('dash-sla-rate').textContent = `${slaRate}%`;
  const targetBadge = document.getElementById('dash-sla-target-badge');
  targetBadge.textContent = `Meta Contratual: ${activeSlaTarget}%`;
  targetBadge.className = `text-xs font-semibold ${
    slaRate >= activeSlaTarget ? 'text-emerald-600' : 'text-rose-600'
  }`;

  // 2. Horas Trabalhadas no escopo
  const hoursUsed = scopedTickets.reduce((acc, t) => acc + (Number(t.hoursSpent) || 0), 0);
  const remaining = Math.max(0, activeQuota - hoursUsed);

  document.getElementById('dash-hours-used').textContent = `${hoursUsed.toFixed(1)}h`;
  if (role === 'ADMIN') {
    document.getElementById('dash-hours-quota').textContent = `de ${activeQuota}h contratadas`;
    document.getElementById('dash-hours-remaining').textContent =
      activeQuota === 0
        ? 'Defina a franquia mensal de horas na aba Clientes & Contratos.'
        : hoursUsed <= activeQuota
        ? `Saldo disponível na franquia mensal: ${remaining.toFixed(1)} horas.`
        : `Atenção: Franquia excedida em ${(hoursUsed - activeQuota).toFixed(1)} horas neste mês.`;
  } else if (role === 'TECH') {
    document.getElementById('dash-hours-quota').textContent = `em ${totalTickets} chamado(s)`;
    document.getElementById('dash-hours-remaining').textContent = `Total de horas técnicas registradas nos seus atendimentos.`;
  } else {
    document.getElementById('dash-hours-quota').textContent = `em ${totalTickets} chamado(s) seus`;
    document.getElementById('dash-hours-remaining').textContent = `Total de horas dedicadas pela equipe técnica aos seus chamados.`;
  }

  // 3. Tempo Médio de Resolução no escopo
  const resolved = scopedTickets.filter((t) => t.status === 'Resolvido' && t.resolvedAt);
  if (resolved.length > 0) {
    const sumHours = resolved.reduce((acc, t) => {
      return acc + (new Date(t.resolvedAt) - new Date(t.createdAt)) / 3600000;
    }, 0);
    document.getElementById('dash-avg-resolution').textContent = (sumHours / resolved.length).toFixed(1) + 'h';
  } else {
    document.getElementById('dash-avg-resolution').textContent = '--';
  }

  // Painel 1: Volume por Tipo de Problema (dentro do escopo do perfil)
  const probContainer = document.getElementById('dash-problems-breakdown');
  if (problems.length === 0) {
    probContainer.innerHTML = `<p class="text-xs text-slate-400">Nenhum tipo de problema cadastrado.</p>`;
  } else {
    probContainer.innerHTML = problems
      .map((p) => {
        const count = scopedTickets.filter((t) => t.problemTypeId === p.id).length;
        const pct = totalTickets > 0 ? Math.round((count / totalTickets) * 100) : 0;
        return `
          <div>
            <div class="flex justify-between text-xs mb-1">
              <span class="font-medium text-slate-700">${escapeHtml(p.name)} <span class="text-slate-400">(SLA ${p.defaultSlaHours}h)</span></span>
              <span class="font-semibold text-slate-900">${count} chamados (${pct}%)</span>
            </div>
            <div class="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
              <div class="h-full bg-indigo-600 rounded-full" style="width: ${pct}%"></div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // Painel 2: Para Admin/Tech mostra por Usuário; para Usuário Comum mostra resumo por Status dos seus chamados
  const userContainer = document.getElementById('dash-users-breakdown');
  if (role === 'USER') {
    const statuses = ['Aberto', 'Em Atendimento', 'Aguardando Cliente', 'Resolvido'];
    userContainer.innerHTML = statuses
      .map((st) => {
        const count = scopedTickets.filter((t) => t.status === st).length;
        const pct = totalTickets > 0 ? Math.round((count / totalTickets) * 100) : 0;
        return `
          <div>
            <div class="flex justify-between text-xs mb-1">
              <span class="font-medium text-slate-700">Status: <strong>${st}</strong></span>
              <span class="font-semibold text-slate-900">${count} chamado(s) (${pct}%)</span>
            </div>
            <div class="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
              <div class="h-full bg-emerald-500 rounded-full" style="width: ${pct}%"></div>
            </div>
          </div>
        `;
      })
      .join('');
  } else {
    const clientUsers = users.filter((u) => {
      if (selectedClientObj && u.clientId !== selectedClientObj.id) return false;
      return (u.accessRole || 'USER') === 'USER' || scopedTickets.some((t) => t.userId === u.id);
    });
    if (clientUsers.length === 0) {
      userContainer.innerHTML = `<p class="text-xs text-slate-400">Nenhum solicitante encontrado neste escopo.</p>`;
    } else {
      userContainer.innerHTML = clientUsers
        .map((u) => {
          const userTickets = scopedTickets.filter((t) => t.userId === u.id);
          const count = userTickets.length;
          const hours = userTickets.reduce((acc, t) => acc + (Number(t.hoursSpent) || 0), 0);
          const pct = totalTickets > 0 ? Math.round((count / totalTickets) * 100) : 0;
          const cliName = getClientNameById(u.clientId);
          return `
            <div>
              <div class="flex justify-between text-xs mb-1">
                <span class="font-medium text-slate-700">${escapeHtml(u.name)} • <span class="text-slate-500">${escapeHtml(u.department)}${
            cliName ? ' (' + escapeHtml(cliName) + ')' : ''
          }</span></span>
                <span class="font-semibold text-slate-900">${count} chamados (${hours.toFixed(1)}h)</span>
              </div>
              <div class="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                <div class="h-full bg-emerald-500 rounded-full" style="width: ${pct}%"></div>
              </div>
            </div>
          `;
        })
        .join('');
    }
  }

  // Painel 3 (Exclusivo Admin): Produtividade & SLA por Técnico
  const techsContainer = document.getElementById('dash-techs-breakdown');
  if (techsContainer && role === 'ADMIN') {
    const techNamesSet = new Set();
    users.filter((u) => u.accessRole === 'TECH').forEach((u) => techNamesSet.add(u.name));
    scopedTickets.forEach((t) => {
      if (t.technician && !isTicketAwaitingAdminTriage(t)) {
        techNamesSet.add(t.technician);
      }
    });

    const techNames = Array.from(techNamesSet);
    if (techNames.length === 0) {
      techsContainer.innerHTML = `<p class="text-xs text-slate-400 col-span-2">Cadastre usuários do tipo "Técnico" ou direcione chamados para visualizar a produtividade da equipe.</p>`;
    } else {
      techsContainer.innerHTML = techNames
        .map((tName) => {
          const tList = scopedTickets.filter(
            (t) => (t.technician || '').toLowerCase().trim() === tName.toLowerCase().trim()
          );
          const count = tList.length;
          const resolvedCount = tList.filter((t) => t.status === 'Resolvido').length;
          const onSla = tList.filter((t) => evaluateTicketSla(t).metSla).length;
          const techSlaRate = count > 0 ? Math.round((onSla / count) * 100) : 100;
          const hours = tList.reduce((acc, t) => acc + (Number(t.hoursSpent) || 0), 0);

          return `
            <div class="p-3.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between">
              <div>
                <p class="font-bold text-sm text-slate-900">${escapeHtml(tName)}</p>
                <p class="text-xs text-slate-500 mt-0.5">${count} chamados (${resolvedCount} resolvidos) • ${hours.toFixed(1)}h apontadas</p>
              </div>
              <div class="text-right">
                <span class="px-2.5 py-1 rounded-full text-xs font-bold ${
                  techSlaRate >= 90 ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                }">SLA: ${techSlaRate}%</span>
              </div>
            </div>
          `;
        })
        .join('');
    }
  }
}

function exportTicketsCSV() {
  const session = window.db.getSession();
  const allTickets = window.db.getTickets();
  const tickets = getScopedTicketsForSession(session, allTickets);
  const users = Object.fromEntries(window.db.getUsers().map((u) => [u.id, u]));
  const clients = Object.fromEntries(window.db.getClients().map((c) => [c.id, c]));
  const problems = Object.fromEntries(window.db.getProblemTypes().map((p) => [p.id, p]));

  const headers = [
    'Protocolo',
    'Titulo',
    'Empresa_Cliente',
    'Usuario_Solicitante',
    'Departamento',
    'Tipo_Problema',
    'SLA_Horas',
    'Prioridade',
    'Status',
    'Situacao_SLA',
    'Tecnico_Responsavel',
    'Horas_Trabalhadas',
    'Aberto_Em',
    'Recebido_Tecnico_Em',
    'Inicio_Atendimento_Em',
    'Vencimento_SLA',
    'Resolvido_Em'
  ];

  const rows = tickets.map((t) => {
    const u = users[t.userId] || {};
    const cli = clients[t.clientId || u.clientId] || {};
    const p = problems[t.problemTypeId] || {};
    const sla = evaluateTicketSla(t);
    return [
      t.id,
      `"${(t.title || '').replace(/"/g, '""')}"`,
      `"${(cli.name || '').replace(/"/g, '""')}"`,
      `"${(u.name || '').replace(/"/g, '""')}"`,
      `"${(u.department || '').replace(/"/g, '""')}"`,
      `"${(p.name || '').replace(/"/g, '""')}"`,
      t.slaHours,
      t.priority,
      t.status,
      `"${sla.label}"`,
      `"${(t.technician || '').replace(/"/g, '""')}"`,
      t.hoursSpent || 0,
      formatDateTimeBR(t.createdAt),
      formatDateTimeBR(t.assignedAt),
      formatDateTimeBR(t.startedAt),
      formatDateTimeBR(t.dueAt),
      formatDateTimeBR(t.resolvedAt)
    ].join(';');
  });

  const csvContent = '\uFEFF' + [headers.join(';'), ...rows].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const rolePrefix = (session?.role || 'user').toLowerCase();
  const link = document.createElement('a');
  link.href = url;
  link.download = `relatorio-${rolePrefix}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  showToast('Planilha CSV exportada de acordo com seu nível de acesso!');
}

// ==========================================
// ABA: MÚLTIPLOS CLIENTES DE CONTRATO FIXO, LOGO DA EMPRESA & BANCO SQL
// ==========================================
let pendingLogoDataUrl = null;

function loadSettingsForms() {
  const c = window.db.getContract() || {};

  // Campos de Identidade Visual e Logo
  const compNameInput = document.getElementById('cfg-company-name');
  if (compNameInput) compNameInput.value = c.companyName || 'ServiceDesk Pro';

  const subInput = document.getElementById('cfg-login-subtitle');
  if (subInput) subInput.value = c.loginSubtitle || 'Portal de Chamados Técnicos & Controle de SLA';

  const supInput = document.getElementById('cfg-support-contact');
  if (supInput) supInput.value = c.supportContact || '';

  const urlInput = document.getElementById('cfg-company-logo-url');
  if (urlInput) {
    urlInput.value = c.companyLogo && !c.companyLogo.startsWith('data:') ? c.companyLogo : '';
  }

  pendingLogoDataUrl = c.companyLogo || '';
  updateSettingsLogoPreview(pendingLogoDataUrl);

  // Campos de Horário de Expediente / Atendimento (SLA Útil)
  const bhStartInput = document.getElementById('cfg-bh-start');
  const bhEndInput = document.getElementById('cfg-bh-end');
  const bhDaysInput = document.getElementById('cfg-bh-days');
  const lunchEnabledInput = document.getElementById('cfg-lunch-enabled');
  const lunchStartInput = document.getElementById('cfg-lunch-start');
  const lunchEndInput = document.getElementById('cfg-lunch-end');

  if (bhStartInput) bhStartInput.value = c.businessHoursStart || '08:00';
  if (bhEndInput) bhEndInput.value = c.businessHoursEnd || '18:00';
  if (bhDaysInput) bhDaysInput.value = c.businessDays || '1,2,3,4,5';
  if (lunchEnabledInput) lunchEnabledInput.checked = c.lunchBreakEnabled !== false && c.lunchBreakEnabled !== 0 && c.lunchBreakEnabled !== '0';
  if (lunchStartInput) lunchStartInput.value = c.lunchStart || '12:00';
  if (lunchEndInput) lunchEndInput.value = c.lunchEnd || '13:00';

  toggleLunchBreakFields();
  updateBusinessHoursCalculations();
  renderClientsList();
}

function toggleLunchBreakFields() {
  const enabled = document.getElementById('cfg-lunch-enabled')?.checked;
  const fields = document.getElementById('cfg-lunch-fields');
  const badge = document.getElementById('lunch-duration-badge');
  if (fields) {
    if (enabled) {
      fields.classList.remove('opacity-40', 'pointer-events-none');
    } else {
      fields.classList.add('opacity-40', 'pointer-events-none');
    }
  }
  if (badge && !enabled) {
    badge.className = 'px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-500 border border-slate-200';
    badge.textContent = 'Sem pausa de almoço';
  }
  updateBusinessHoursCalculations();
}

function updateBusinessHoursCalculations() {
  const startInput = document.getElementById('cfg-bh-start');
  const endInput = document.getElementById('cfg-bh-end');
  const daysInput = document.getElementById('cfg-bh-days');
  const lunchEnabledInput = document.getElementById('cfg-lunch-enabled');
  const lunchStartInput = document.getElementById('cfg-lunch-start');
  const lunchEndInput = document.getElementById('cfg-lunch-end');
  if (!startInput || !endInput || !daysInput) return;

  const startVal = startInput.value || '08:00';
  const endVal = endInput.value || '18:00';
  const daysVal = daysInput.value || '1,2,3,4,5';
  const lunchEnabled = lunchEnabledInput ? lunchEnabledInput.checked : true;
  const lunchStartVal = (lunchStartInput ? lunchStartInput.value : '') || '12:00';
  const lunchEndVal = (lunchEndInput ? lunchEndInput.value : '') || '13:00';

  // Atualiza hint de duração diária
  const [sh, sm] = startVal.split(':').map(Number);
  const [eh, em] = endVal.split(':').map(Number);
  const totalMins = (eh * 60 + (em || 0)) - (sh * 60 + (sm || 0));

  let lunchMins = 0;
  if (lunchEnabled) {
    const [lsh, lsm] = lunchStartVal.split(':').map(Number);
    const [leh, lem] = lunchEndVal.split(':').map(Number);
    if (!isNaN(lsh) && !isNaN(leh)) {
      lunchMins = Math.max(0, (leh * 60 + (lem || 0)) - (lsh * 60 + (lsm || 0)));
    }
  }

  const netMins = Math.max(0, totalMins - lunchMins);
  const netHours = (netMins / 60).toFixed(1).replace('.0', '');
  const durationHint = document.getElementById('bh-duration-hint');
  if (durationHint) {
    durationHint.textContent = `${netHours}h úteis líquidas/dia`;
  }

  const lunchDurationBadge = document.getElementById('lunch-duration-badge');
  if (lunchDurationBadge) {
    if (lunchEnabled && lunchMins > 0) {
      const lHours = (lunchMins / 60).toFixed(1).replace('.0', '');
      lunchDurationBadge.className = 'px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-100 text-amber-900 border border-amber-200';
      lunchDurationBadge.textContent = `Pausa de ${lHours}h (${lunchStartVal} às ${lunchEndVal})`;
    } else {
      lunchDurationBadge.className = 'px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-500 border border-slate-200';
      lunchDurationBadge.textContent = 'Sem pausa de almoço';
    }
  }

  // Atualiza botões dos dias 1 a 7
  const allowedDays = daysVal.split(',').map((x) => Number(x.trim())).filter((x) => !isNaN(x) && x >= 1 && x <= 7);
  for (let d = 1; d <= 7; d++) {
    const btn = document.getElementById(`btn-day-${d}`);
    if (btn) {
      if (allowedDays.includes(d)) {
        btn.className = 'bh-day-btn py-2 px-1 text-center rounded-lg border text-xs font-bold transition-all cursor-pointer bg-indigo-600 text-white border-indigo-700 shadow-2xs';
      } else {
        btn.className = 'bh-day-btn py-2 px-1 text-center rounded-lg border text-xs font-bold transition-all cursor-pointer bg-slate-100 text-slate-400 border-slate-200';
      }
    }
  }

  // Resumo dos dias
  const summaryEl = document.getElementById('cfg-bh-days-summary');
  if (summaryEl) {
    if (allowedDays.length === 5 && !allowedDays.includes(6) && !allowedDays.includes(7)) {
      summaryEl.textContent = '5 dias úteis (Segunda a Sexta)';
    } else if (allowedDays.length === 6 && !allowedDays.includes(7)) {
      summaryEl.textContent = '6 dias úteis (Segunda a Sábado)';
    } else if (allowedDays.length === 7) {
      summaryEl.textContent = '7 dias por semana (Regime 24/7)';
    } else {
      summaryEl.textContent = `${allowedDays.length} dias da semana selecionados`;
    }
  }

  // Badge no topo do painel
  const badgeLabel = document.getElementById('business-hours-badge-label');
  if (badgeLabel) {
    const daysLabel = allowedDays.length === 7 ? 'Todos os dias' : allowedDays.length === 6 ? 'Seg a Sáb' : 'Seg a Sex';
    const lunchInfo = lunchEnabled && lunchMins > 0 ? ` • Almoço ${lunchStartVal}-${lunchEndVal}` : '';
    badgeLabel.textContent = `Expediente: ${startVal} às ${endVal} (${daysLabel}${lunchInfo})`;
  }

  // Simulação Interativa ao Vivo com a hora atual
  const simCurrentTime = document.getElementById('sim-current-time');
  const simBadge = document.getElementById('sim-status-badge');
  const simExplanation = document.getElementById('sim-explanation');

  if (simCurrentTime && simBadge && simExplanation) {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    simCurrentTime.textContent = timeStr;

    const mockConfig = {
      businessHoursStart: startVal,
      businessHoursEnd: endVal,
      businessDays: daysVal,
      lunchBreakEnabled: lunchEnabled,
      lunchStart: lunchStartVal,
      lunchEnd: lunchEndVal
    };
    const bhStatus = isCurrentTimeInBusinessHours(mockConfig);

    const simFirstDue = window.db.calculateBusinessDue(now, 1.0, mockConfig);
    const simResDue = window.db.calculateBusinessDue(now, 4.0, mockConfig);

    if (bhStatus.isLunch) {
      simBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300';
      simBadge.textContent = '🍽️ Intervalo de Almoço Agora (SLA Pausado)';
      simExplanation.innerHTML = `Neste momento estamos na <strong>pausa de almoço da equipe</strong> (${lunchStartVal} às ${lunchEndVal}). Se abrir um chamado agora às ${timeStr}, o cronômetro do SLA <strong>NÃO CORRE DURANTE O ALMOÇO</strong>. O prazo só iniciará às <strong>${lunchEndVal}</strong>. A 1ª Resposta vencerá às <strong>${formatDateTimeBR(simFirstDue.toISOString())}</strong> e a Resolução às <strong>${formatDateTimeBR(simResDue.toISOString())}</strong>.`;
    } else if (bhStatus.isOpen) {
      simBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300';
      simBadge.textContent = '🟢 Expediente Comercial Aberto Agora';
      const lunchNote = lunchEnabled ? ` (se o chamado cruzar o almoço de ${lunchStartVal} às ${lunchEndVal}, o tempo de pausa é somado automaticamente)` : '';
      simExplanation.innerHTML = `Neste momento estamos <strong>dentro do horário útil de atendimento</strong> (${startVal} às ${endVal}). Um chamado aberto agora às ${timeStr} terá 1ª resposta esperada até <strong>${formatDateTimeBR(simFirstDue.toISOString())}</strong> e prazo de resolução até <strong>${formatDateTimeBR(simResDue.toISOString())}</strong>${lunchNote}.`;
    } else {
      simBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300';
      simBadge.textContent = '🌙 Suporte Fechado Agora (SLA Pausado)';
      simExplanation.innerHTML = `Neste momento estamos <strong>fora do expediente comercial</strong>. Se você abrir um chamado agora às ${timeStr}, o cronômetro do SLA <strong>NÃO CORRERÁ DURANTE A NOITE</strong>. O prazo só começará a ser contado no próximo dia útil às <strong>${startVal}</strong>. A 1ª Resposta vencerá em <strong>${formatDateTimeBR(simFirstDue.toISOString())}</strong> e a Resolução em <strong>${formatDateTimeBR(simResDue.toISOString())}</strong>.`;
    }
  }

  if (window.lucide) lucide.createIcons();
}

function toggleBusinessDay(dayNum) {
  const daysInput = document.getElementById('cfg-bh-days');
  if (!daysInput) return;
  const current = daysInput.value.split(',').map((x) => Number(x.trim())).filter((x) => !isNaN(x) && x >= 1 && x <= 7);
  let updated = [];
  if (current.includes(dayNum)) {
    if (current.length <= 1) {
      showToast('Selecione pelo menos 1 dia útil de atendimento.', 'error');
      return;
    }
    updated = current.filter((d) => d !== dayNum);
  } else {
    updated = [...current, dayNum].sort((a, b) => a - b);
  }
  daysInput.value = updated.join(',');
  updateBusinessHoursCalculations();
}

function applyBusinessHoursPreset(presetKey) {
  const startInput = document.getElementById('cfg-bh-start');
  const endInput = document.getElementById('cfg-bh-end');
  const daysInput = document.getElementById('cfg-bh-days');
  const lunchEnabledInput = document.getElementById('cfg-lunch-enabled');
  const lunchStartInput = document.getElementById('cfg-lunch-start');
  const lunchEndInput = document.getElementById('cfg-lunch-end');
  if (!startInput || !endInput || !daysInput) return;

  const presets = {
    comercial: { start: '08:00', end: '18:00', days: '1,2,3,4,5', lunch: true, lStart: '12:00', lEnd: '13:00', label: 'Comercial Padrão (08h-18h • Almoço 12h-13h • Seg a Sex)' },
    flex: { start: '09:00', end: '18:00', days: '1,2,3,4,5', lunch: true, lStart: '12:00', lEnd: '13:00', label: 'Comercial Flex (09h-18h • Almoço 12h-13h • Seg a Sex)' },
    estendido: { start: '08:00', end: '20:00', days: '1,2,3,4,5', lunch: true, lStart: '12:00', lEnd: '13:00', label: 'Suporte Estendido (08h-20h • Almoço 12h-13h • Seg a Sex)' },
    plantao: { start: '00:00', end: '23:59', days: '1,2,3,4,5,6,7', lunch: false, lStart: '12:00', lEnd: '13:00', label: 'Plantão 24/7 (Sem pausa • Todos os dias)' }
  };

  const p = presets[presetKey];
  if (!p) return;

  startInput.value = p.start;
  endInput.value = p.end;
  daysInput.value = p.days;
  if (lunchEnabledInput) lunchEnabledInput.checked = p.lunch;
  if (lunchStartInput) lunchStartInput.value = p.lStart;
  if (lunchEndInput) lunchEndInput.value = p.lEnd;

  toggleLunchBreakFields();
  updateBusinessHoursCalculations();
  showToast(`Predefinição aplicada: ${p.label}`);
}

async function handleSaveBusinessHours(e) {
  e.preventDefault();
  const start = document.getElementById('cfg-bh-start')?.value || '08:00';
  const end = document.getElementById('cfg-bh-end')?.value || '18:00';
  const days = document.getElementById('cfg-bh-days')?.value || '1,2,3,4,5';
  const lunchEnabled = document.getElementById('cfg-lunch-enabled')?.checked ?? true;
  const lunchStart = document.getElementById('cfg-lunch-start')?.value || '12:00';
  const lunchEnd = document.getElementById('cfg-lunch-end')?.value || '13:00';

  try {
    await window.db.updateContract({
      businessHoursStart: start,
      businessHoursEnd: end,
      businessDays: days,
      lunchBreakEnabled: lunchEnabled,
      lunchStart,
      lunchEnd
    });
    refreshAllViews();
    showToast('Regras de horário de expediente, pausa de almoço e SLA atualizadas com sucesso!');
  } catch (err) {
    showToast(err.message || 'Erro ao salvar horário de atendimento.', 'error');
  }
}

function renderClientsList() {
  const clients = window.db.getClients();
  const users = window.db.getUsers();
  const tickets = window.db.getTickets();
  const container = document.getElementById('clients-list-container');
  const subtitle = document.getElementById('clients-table-subtitle');
  if (!container) return;

  if (subtitle) {
    subtitle.textContent = `${clients.length} cliente(s) de contrato cadastrado(s)`;
  }

  if (clients.length === 0) {
    container.innerHTML = `
      <div class="col-span-2 p-8 rounded-xl bg-slate-50 border border-dashed border-slate-300 text-center text-slate-400 text-xs">
        Nenhum cliente de contrato fixo cadastrado ainda. Utilize o formulário <strong>"Cadastrar Cliente de Contrato Fixo"</strong> acima para registrar sua primeira empresa cliente (e quantas outras desejar).
      </div>
    `;
    return;
  }

  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  container.innerHTML = clients
    .map((cli) => {
      const cliUsersCount = users.filter((u) => u.clientId === cli.id).length;
      const cliTickets = tickets.filter((t) => {
        const effId = t.clientId || userMap[t.userId]?.clientId || '';
        return effId === cli.id;
      });
      const hoursUsed = cliTickets.reduce((acc, t) => acc + (Number(t.hoursSpent) || 0), 0);
      const quota = Number(cli.monthlyHoursQuota) || 0;
      const pct = quota > 0 ? Math.min(100, Math.round((hoursUsed / quota) * 100)) : 0;

      const statusBadge =
        cli.status === 'Ativo'
          ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
          : cli.status === 'Suspenso'
          ? 'bg-amber-100 text-amber-800 border-amber-300'
          : 'bg-slate-200 text-slate-700 border-slate-300';

      return `
        <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-col justify-between gap-3">
          <div>
            <div class="flex items-start justify-between gap-2">
              <div>
                <div class="flex items-center gap-2 flex-wrap">
                  <h5 class="font-bold text-slate-900 text-sm">${escapeHtml(cli.name)}</h5>
                  <span class="px-2 py-0.5 rounded-full text-[10px] font-bold border ${statusBadge}">${escapeHtml(cli.status || 'Ativo')}</span>
                </div>
                <p class="text-xs text-slate-500 mt-0.5">
                  Contrato: <strong>${escapeHtml(cli.contractNumber || 'S/N')}</strong>
                  ${cli.cnpj ? ' • CNPJ: ' + escapeHtml(cli.cnpj) : ''}
                </p>
              </div>
              <span class="px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200 text-xs font-bold shrink-0">
                Meta SLA: ${cli.slaTargetPercent || 95}%
              </span>
            </div>

            <div class="mt-3 p-2.5 rounded-lg bg-white border border-slate-200">
              <div class="flex justify-between text-xs mb-1">
                <span class="text-slate-500">Consumo da Franquia Mensal</span>
                <span class="font-bold text-slate-800">${hoursUsed.toFixed(1)}h / ${quota}h (${pct}%)</span>
              </div>
              <div class="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div class="h-full ${pct >= 90 ? 'bg-rose-500' : 'bg-indigo-600'} rounded-full" style="width: ${pct}%"></div>
              </div>
            </div>

            <div class="mt-2.5 flex flex-wrap items-center justify-between text-[11px] text-slate-500 gap-2">
              <span>Gestor: <strong>${escapeHtml(cli.managerName || '--')}</strong> ${cli.phone ? '(' + escapeHtml(cli.phone) + ')' : ''}</span>
              <span><strong>${cliUsersCount}</strong> usuário(s) • <strong>${cliTickets.length}</strong> chamado(s)</span>
            </div>
          </div>

          <div class="pt-2 border-t border-slate-200 flex items-center justify-end gap-2">
            <button type="button" onclick="startEditClient('${cli.id}')" class="px-3 py-1.5 rounded-lg bg-white hover:bg-slate-100 border border-slate-300 text-slate-700 text-xs font-semibold cursor-pointer">
              Editar Contrato
            </button>
            <button type="button" onclick="handleDeleteClient('${cli.id}')" class="px-3 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-600 text-rose-700 hover:text-white border border-rose-200 text-xs font-semibold transition-colors cursor-pointer">
              Excluir
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

function startEditClient(clientId) {
  const cli = window.db.getClients().find((c) => c.id === clientId);
  if (!cli) return;

  document.getElementById('edit-client-id').value = cli.id;
  document.getElementById('cfg-client-name').value = cli.name || '';
  document.getElementById('cfg-client-cnpj').value = cli.cnpj || '';
  document.getElementById('cfg-contract-num').value = cli.contractNumber || '';
  document.getElementById('cfg-hours-quota').value = cli.monthlyHoursQuota ?? 0;
  document.getElementById('cfg-sla-target').value = cli.slaTargetPercent || 95;
  document.getElementById('cfg-manager').value = cli.managerName || '';
  const phoneInput = document.getElementById('cfg-client-phone');
  if (phoneInput) phoneInput.value = cli.phone || '';
  const statusSel = document.getElementById('cfg-client-status');
  if (statusSel) statusSel.value = cli.status || 'Ativo';

  document.getElementById('client-form-title').innerHTML = `<i data-lucide="file-edit" class="w-4 h-4 text-indigo-600"></i><span>Editando Cliente: ${escapeHtml(cli.name)}</span>`;
  document.getElementById('btn-submit-client').textContent = 'Salvar Alterações do Cliente';
  document.getElementById('btn-cancel-client-edit').classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function cancelEditClient() {
  const form = document.getElementById('form-client-contract');
  if (form) form.reset();
  document.getElementById('edit-client-id').value = '';
  document.getElementById('cfg-sla-target').value = 95;
  const statusSel = document.getElementById('cfg-client-status');
  if (statusSel) statusSel.value = 'Ativo';

  document.getElementById('client-form-title').innerHTML = `<i data-lucide="building-2" class="w-4 h-4 text-indigo-600"></i><span>Cadastrar Cliente de Contrato Fixo</span>`;
  document.getElementById('btn-submit-client').textContent = 'Adicionar Cliente de Contrato no Banco';
  document.getElementById('btn-cancel-client-edit').classList.add('hidden');
  if (window.lucide) lucide.createIcons();
}

async function handleDeleteClient(clientId) {
  const cli = window.db.getClients().find((c) => c.id === clientId);
  await window.db.deleteClient(clientId);
  if (document.getElementById('edit-client-id')?.value === clientId) {
    cancelEditClient();
  }
  refreshAllViews();
  showToast(`Cliente ${cli ? cli.name : ''} removido do banco.`, 'info');
}

function updateSettingsLogoPreview(logoSrc) {
  const preview = document.getElementById('cfg-logo-preview');
  const fallback = document.getElementById('cfg-logo-fallback');
  if (!preview || !fallback) return;

  if (logoSrc) {
    preview.src = logoSrc;
    preview.classList.remove('hidden');
    fallback.classList.add('hidden');
  } else {
    preview.src = '';
    preview.classList.add('hidden');
    fallback.classList.remove('hidden');
  }
}

function handleLogoFileSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  if (file.size > 2 * 1024 * 1024) {
    showToast('Escolha uma imagem de até 2MB para a logo.', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    pendingLogoDataUrl = reader.result;
    const urlInput = document.getElementById('cfg-company-logo-url');
    if (urlInput) urlInput.value = '';
    updateSettingsLogoPreview(pendingLogoDataUrl);
  };
  reader.readAsDataURL(file);
}

function onLogoUrlInput() {
  const val = document.getElementById('cfg-company-logo-url')?.value.trim() || '';
  pendingLogoDataUrl = val;
  updateSettingsLogoPreview(pendingLogoDataUrl);
}

function clearCompanyLogo() {
  pendingLogoDataUrl = '';
  const urlInput = document.getElementById('cfg-company-logo-url');
  const fileInput = document.getElementById('cfg-logo-file');
  if (urlInput) urlInput.value = '';
  if (fileInput) fileInput.value = '';
  updateSettingsLogoPreview('');
}

async function handleSaveBranding(e) {
  e.preventDefault();
  const payload = {
    companyName: document.getElementById('cfg-company-name').value.trim() || 'ServiceDesk Pro',
    companyLogo: pendingLogoDataUrl || '',
    loginSubtitle:
      document.getElementById('cfg-login-subtitle').value.trim() ||
      'Portal de Chamados Técnicos & Controle de SLA',
    supportContact: document.getElementById('cfg-support-contact').value.trim()
  };

  await window.db.updateContract(payload);
  refreshAllViews();
  showToast('Logo e identidade visual salvas com sucesso!');
}

async function handleSaveContract(e) {
  e.preventDefault();
  const editClientId = document.getElementById('edit-client-id')?.value || '';
  const clientPayload = {
    name: document.getElementById('cfg-client-name').value.trim(),
    cnpj: document.getElementById('cfg-client-cnpj').value.trim(),
    contractNumber: document.getElementById('cfg-contract-num').value.trim(),
    monthlyHoursQuota: Number(document.getElementById('cfg-hours-quota').value) || 0,
    slaTargetPercent: Number(document.getElementById('cfg-sla-target').value) || 95,
    managerName: document.getElementById('cfg-manager').value.trim(),
    phone: document.getElementById('cfg-client-phone')?.value.trim() || '',
    status: document.getElementById('cfg-client-status')?.value || 'Ativo'
  };

  const newPass = document.getElementById('cfg-admin-pass')?.value.trim() || '';

  try {
    if (editClientId) {
      await window.db.updateClient(editClientId, clientPayload);
      showToast(`Contrato de ${clientPayload.name} atualizado com sucesso!`);
    } else {
      await window.db.addClient(clientPayload);
      showToast(`Cliente ${clientPayload.name} adicionado aos contratos fixos!`);
    }

    if (newPass) {
      await window.db.updateContract({ adminPassword: newPass });
      document.getElementById('cfg-admin-pass').value = '';
    }

    cancelEditClient();
    refreshAllViews();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function copySqlSchema() {
  const sql = window.db.getPostgresSchemaSQL();
  navigator.clipboard.writeText(sql).then(() => {
    showToast('Schema SQL copiado para a área de transferência!');
  });
}

async function resetDatabaseConfirm() {
  await window.db.clearAllDatabase();
  refreshAllViews();
  showToast('Banco de dados 100% zerado para cadastro do zero!', 'info');
}

// ==========================================
// ABA 6: CONFIGURAÇÕES & MEU PERFIL (MUDAR DE COR, TROCA DE SENHA E FOTO DO PERFIL)
// ==========================================
let pendingProfileAvatar = '';

function loadProfileTab() {
  const session = window.db.getSession();
  if (!session) return;

  const contract = window.db.getContract() || {};
  const userObj = session.userId ? window.db.getUsers().find((u) => u.id === session.userId) : null;
  const mustChange = isSessionForcedPasswordChange(session);

  const displayName = userObj?.name || session.name || 'Administrador Geral';
  const displayEmail = userObj?.email || session.email || 'admin';
  const displayPhone = userObj?.phone || session.phone || '';
  const avatarSrc = userObj ? userObj.avatar : session.userId ? session.avatar : contract.adminAvatar || session.avatar || '';
  const activeColor = userObj?.themeColor || session.themeColor || contract.themeColor || 'indigo';

  applyThemeColor(activeColor);

  // Banner e badge de Troca Obrigatória no 1º Acesso
  const firstLoginBanner = document.getElementById('first-login-password-banner');
  const pwdCard = document.getElementById('profile-password-card');
  const pwdBadge = document.getElementById('profile-pwd-status-badge');
  if (firstLoginBanner) {
    if (mustChange) firstLoginBanner.classList.remove('hidden');
    else firstLoginBanner.classList.add('hidden');
  }
  if (pwdCard) {
    if (mustChange) {
      pwdCard.className = 'bg-amber-50/40 p-6 rounded-xl border-2 border-amber-400 shadow-sm h-fit';
    } else {
      pwdCard.className = 'bg-white p-6 rounded-xl border border-slate-200 shadow-xs h-fit';
    }
  }
  if (pwdBadge) {
    if (mustChange) {
      pwdBadge.textContent = '1º Acesso: Troca Obrigatória';
      pwdBadge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-200 text-amber-950';
    } else {
      pwdBadge.textContent = 'Senha Pessoal Ativa';
      pwdBadge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800';
    }
  }

  const cardName = document.getElementById('profile-card-name');
  const cardEmail = document.getElementById('profile-card-email');
  const cardContract = document.getElementById('profile-card-contract');
  if (cardName) cardName.textContent = displayName;
  if (cardEmail) cardEmail.textContent = displayEmail;
  if (cardContract) {
    const cliId = userObj?.clientId || session.clientId || '';
    const cli = cliId ? window.db.getClients().find((c) => c.id === cliId) : null;
    cardContract.textContent = cli
      ? `Contrato vinculado: ${cli.name}${cli.contractNumber ? ' (' + cli.contractNumber + ')' : ''}`
      : session.role === 'ADMIN'
      ? 'Perfil: Administração Geral de Contratos'
      : '';
  }

  const nameInput = document.getElementById('profile-name-input');
  const phoneInput = document.getElementById('profile-phone-input');
  if (nameInput) nameInput.value = displayName;
  if (phoneInput) phoneInput.value = displayPhone;

  const urlInput = document.getElementById('profile-avatar-url');
  if (urlInput) {
    urlInput.value = avatarSrc && !avatarSrc.startsWith('data:') ? avatarSrc : '';
  }

  pendingProfileAvatar = avatarSrc || '';
  updateProfileAvatarPreview(pendingProfileAvatar, displayName);
}

function updateProfileAvatarPreview(src, nameForInitials) {
  const img = document.getElementById('profile-avatar-preview');
  const fallback = document.getElementById('profile-avatar-fallback');
  if (!img || !fallback) return;

  if (src) {
    img.src = src;
    img.classList.remove('hidden');
    fallback.classList.add('hidden');
  } else {
    img.src = '';
    img.classList.add('hidden');
    fallback.textContent = getInitials(nameForInitials || 'US');
    fallback.classList.remove('hidden');
  }
}

async function handleSelectThemeColor(colorName) {
  applyThemeColor(colorName);
  const session = window.db.getSession();
  if (!session) return;

  try {
    await window.db.updateMyProfile({
      userId: session.userId || null,
      themeColor: colorName
    });
    showToast(`Tema alterado para ${THEME_LABELS[colorName] || colorName}!`);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function handleProfileAvatarSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    showToast('Escolha uma foto de até 2MB.', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingProfileAvatar = reader.result;
    const urlInput = document.getElementById('profile-avatar-url');
    if (urlInput) urlInput.value = '';
    const session = window.db.getSession();
    updateProfileAvatarPreview(pendingProfileAvatar, session?.name);
  };
  reader.readAsDataURL(file);
}

function onProfileAvatarUrlInput() {
  const val = document.getElementById('profile-avatar-url')?.value.trim() || '';
  pendingProfileAvatar = val;
  const session = window.db.getSession();
  updateProfileAvatarPreview(pendingProfileAvatar, session?.name);
}

function clearProfileAvatar() {
  pendingProfileAvatar = '';
  const fileInput = document.getElementById('profile-avatar-file');
  const urlInput = document.getElementById('profile-avatar-url');
  if (fileInput) fileInput.value = '';
  if (urlInput) urlInput.value = '';
  const session = window.db.getSession();
  updateProfileAvatarPreview('', session?.name);
}

async function handleSaveMyProfilePhotoAndInfo(e) {
  e.preventDefault();
  const session = window.db.getSession();
  if (!session) return;

  const name = document.getElementById('profile-name-input')?.value.trim() || session.name;
  const phone = document.getElementById('profile-phone-input')?.value.trim() || '';

  try {
    await window.db.updateMyProfile({
      userId: session.userId || null,
      name,
      phone,
      avatar: pendingProfileAvatar
    });
    refreshAllViews();
    showToast('Foto de perfil e dados pessoais atualizados!');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleChangeMyPassword(e) {
  e.preventDefault();
  const session = window.db.getSession();
  if (!session) return;

  const wasForcedFirstAccess = isSessionForcedPasswordChange(session);
  const currentPassword = document.getElementById('pwd-current').value.trim();
  const newPassword = document.getElementById('pwd-new').value.trim();
  const confirmPassword = document.getElementById('pwd-confirm').value.trim();

  if (newPassword !== confirmPassword) {
    showToast('A confirmação da nova senha não confere.', 'error');
    return;
  }

  if (wasForcedFirstAccess && newPassword === currentPassword) {
    showToast('No primeiro acesso, escolha uma nova senha diferente da senha temporária atual.', 'error');
    return;
  }

  try {
    await window.db.updateMyProfile({
      userId: session.userId || null,
      currentPassword,
      newPassword
    });
    document.getElementById('form-change-password').reset();
    refreshAllViews();
    if (wasForcedFirstAccess) {
      showToast('Nova senha pessoal cadastrada! Seu acesso completo ao portal foi liberado.');
    } else {
      showToast('Sua senha foi alterada com sucesso!');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================
// ABA: INVENTÁRIO DE EQUIPAMENTOS & ATIVOS DE TI
// ==========================================

function getEquipmentTypeIcon(type) {
  const map = {
    'Desktop': 'monitor',
    'Notebook': 'laptop',
    'Servidor': 'server',
    'Impressora': 'printer',
    'Roteador / Switch': 'network',
    'Nobreak': 'zap',
    'Monitor': 'tv',
    'Outro': 'hard-drive'
  };
  return map[type] || 'cpu';
}

function renderInventory() {
  const invTableBody = document.getElementById('inv-table-body');
  if (!invTableBody) return;

  const equipments = window.db.getEquipments ? window.db.getEquipments() : [];
  const tickets = window.db.getTickets ? window.db.getTickets() : [];
  const clients = window.db.getClients ? window.db.getClients() : [];
  const users = window.db.getUsers ? window.db.getUsers() : [];

  const clientMap = Object.fromEntries(clients.map((c) => [c.id, c.name]));
  const userMap = Object.fromEntries(users.map((u) => [u.id, u.name]));

  // Mapa de chamados por equipamento
  const ticketsByEquipId = {};
  const activeTicketsByEquipId = {};
  for (const t of tickets) {
    if (t.equipmentId) {
      ticketsByEquipId[t.equipmentId] = (ticketsByEquipId[t.equipmentId] || 0) + 1;
      if (t.status !== 'FECHADO' && t.status !== 'RESOLVIDO') {
        activeTicketsByEquipId[t.equipmentId] = (activeTicketsByEquipId[t.equipmentId] || 0) + 1;
      }
    }
  }

  // Atualiza KPIs do Inventário
  const kpiTotal = document.getElementById('inv-kpi-total');
  const kpiWorkstations = document.getElementById('inv-kpi-workstations');
  const kpiServers = document.getElementById('inv-kpi-servers');
  const kpiWithTickets = document.getElementById('inv-kpi-with-tickets');

  if (kpiTotal) kpiTotal.textContent = equipments.length;
  if (kpiWorkstations) {
    const workstationsCount = equipments.filter(
      (e) => e.type === 'Desktop' || e.type === 'Notebook'
    ).length;
    kpiWorkstations.textContent = workstationsCount;
  }
  if (kpiServers) {
    const serversCount = equipments.filter(
      (e) => e.type === 'Servidor' || e.type === 'Roteador / Switch'
    ).length;
    kpiServers.textContent = serversCount;
  }
  if (kpiWithTickets) {
    const withTicketsCount = Object.keys(activeTicketsByEquipId).length;
    kpiWithTickets.textContent = withTicketsCount;
  }

  // Preenche filtro de clientes mantendo a seleção atual
  const clientFilter = document.getElementById('inv-filter-client');
  if (clientFilter) {
    const currentVal = clientFilter.value;
    const clientOptions = ['<option value="ALL">Todas as Empresas Clientes</option>'];
    for (const cli of clients) {
      clientOptions.push(`<option value="${cli.id}">${escapeHtml(cli.name)}</option>`);
    }
    clientFilter.innerHTML = clientOptions.join('');
    if (currentVal && clients.some((c) => c.id === currentVal)) {
      clientFilter.value = currentVal;
    }
  }

  // Aplica filtros de pesquisa, tipo e cliente
  const searchInput = document.getElementById('inv-filter-search');
  const query = (searchInput ? searchInput.value : '').toLowerCase().trim();
  const selectedType = document.getElementById('inv-filter-type')?.value || 'ALL';
  const selectedClient = document.getElementById('inv-filter-client')?.value || 'ALL';

  const filtered = equipments.filter((eq) => {
    if (selectedType !== 'ALL' && eq.type !== selectedType) {
      return false;
    }
    if (selectedClient !== 'ALL' && eq.clientId !== selectedClient) {
      return false;
    }
    if (query) {
      const cName = (clientMap[eq.clientId] || '').toLowerCase();
      const uName = (userMap[eq.userId] || '').toLowerCase();
      const eqName = (eq.name || '').toLowerCase();
      const eqSerial = (eq.serialNumber || '').toLowerCase();
      const eqType = (eq.type || '').toLowerCase();
      const eqNotes = (eq.notes || '').toLowerCase();
      const match =
        eqName.includes(query) ||
        eqSerial.includes(query) ||
        eqType.includes(query) ||
        cName.includes(query) ||
        uName.includes(query) ||
        eqNotes.includes(query);
      if (!match) return false;
    }
    return true;
  });

  const subtitle = document.getElementById('inv-table-subtitle');
  if (subtitle) {
    subtitle.textContent = `${filtered.length} equipamento(s) listado(s)`;
  }

  const session = window.db.getSession();
  const isAdmin = session?.role === 'ADMIN';

  if (filtered.length === 0) {
    invTableBody.innerHTML = `
      <tr>
        <td colspan="7" class="py-12 text-center text-slate-400">
          <div class="flex flex-col items-center justify-center gap-2">
            <i data-lucide="cpu" class="w-10 h-10 text-slate-300"></i>
            <p class="text-sm font-medium text-slate-600">Nenhum equipamento encontrado no inventário.</p>
            <p class="text-xs text-slate-400">Cadastre novos equipamentos ou ajuste os filtros acima.</p>
            <button
              onclick="openNewEquipmentModal()"
              class="mt-2 px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 text-xs font-semibold hover:bg-indigo-100 transition-colors"
            >
              + Adicionar Primeiro Ativo
            </button>
          </div>
        </td>
      </tr>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  invTableBody.innerHTML = filtered
    .map((eq) => {
      const iconName = getEquipmentTypeIcon(eq.type);
      const totalTickets = ticketsByEquipId[eq.id] || 0;
      const activeTickets = activeTicketsByEquipId[eq.id] || 0;
      const clientName = clientMap[eq.clientId] || 'Geral / Sem Cliente';
      const userName = userMap[eq.userId] || 'Não atribuído';
      const dateFormatted = eq.createdAt ? new Date(eq.createdAt).toLocaleDateString('pt-BR') : '--';

      const activeBadge =
        activeTickets > 0
          ? `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 ml-1.5 animate-pulse">
               ${activeTickets} aberto(s)
             </span>`
          : '';

      return `
        <tr class="hover:bg-slate-50 transition-colors border-b border-slate-100">
          <td class="py-3 px-4">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                <i data-lucide="${iconName}" class="w-4 h-4 text-indigo-600"></i>
              </div>
              <div>
                <strong class="text-slate-900 block font-semibold text-xs leading-snug">${escapeHtml(eq.name)}</strong>
                <span class="text-[11px] text-slate-500 font-medium">${escapeHtml(eq.type)}</span>
              </div>
            </div>
          </td>
          <td class="py-3 px-4 font-mono text-xs font-semibold text-indigo-700">
            <span class="bg-indigo-50 px-2 py-1 rounded border border-indigo-100 inline-flex items-center gap-1">
              <i data-lucide="tag" class="w-3 h-3 text-indigo-500"></i>
              ${escapeHtml(eq.serialNumber || 'S/N')}
            </span>
          </td>
          <td class="py-3 px-4 text-xs text-slate-600">
            <span class="font-medium text-slate-800">${escapeHtml(clientName)}</span>
          </td>
          <td class="py-3 px-4 text-xs text-slate-600">
            <span>${escapeHtml(userName)}</span>
          </td>
          <td class="py-3 px-4 text-center">
            <button
              onclick="openEquipmentHistory('${eq.id}')"
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-indigo-50 hover:text-indigo-700 text-slate-700 transition-colors cursor-pointer border border-slate-200"
              title="Visualizar histórico completo de chamados deste equipamento"
            >
              <i data-lucide="history" class="w-3.5 h-3.5"></i>
              <span>${totalTickets} chamado(s)</span>
              ${activeBadge}
            </button>
          </td>
          <td class="py-3 px-4 text-xs text-slate-500">
            ${dateFormatted}
          </td>
          <td class="py-3 px-4 text-right">
            <div class="flex items-center justify-end gap-1.5">
              <button
                onclick="openEquipmentHistory('${eq.id}')"
                class="p-1.5 text-slate-400 hover:text-indigo-600 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
                title="Histórico de Chamados"
              >
                <i data-lucide="history" class="w-4 h-4"></i>
              </button>
              <button
                onclick="editEquipment('${eq.id}')"
                class="p-1.5 text-slate-400 hover:text-indigo-600 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
                title="Editar Equipamento"
              >
                <i data-lucide="edit-3" class="w-4 h-4"></i>
              </button>
              ${
                isAdmin
                  ? `<button
                      onclick="deleteEquipmentConfirm('${eq.id}')"
                      class="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 transition-colors cursor-pointer"
                      title="Excluir do Inventário"
                    >
                      <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>`
                  : ''
              }
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  if (window.lucide) {
    lucide.createIcons();
  }
}

function populateEquipFormClients(selectedClientId = '') {
  const select = document.getElementById('equip-form-client');
  if (!select) return;
  const clients = window.db.getClients ? window.db.getClients() : [];
  const options = ['<option value="">Geral / Sem Cliente Específico</option>'];
  for (const c of clients) {
    options.push(
      `<option value="${c.id}" ${c.id === selectedClientId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
    );
  }
  select.innerHTML = options.join('');
}

function populateEquipFormUsers(clientId = '', selectedUserId = '') {
  const select = document.getElementById('equip-form-user');
  if (!select) return;
  const allUsers = window.db.getUsers ? window.db.getUsers() : [];
  const filteredUsers = clientId
    ? allUsers.filter((u) => !u.clientId || u.clientId === clientId)
    : allUsers;

  const options = ['<option value="">Não atribuído</option>'];
  for (const u of filteredUsers) {
    options.push(
      `<option value="${u.id}" ${u.id === selectedUserId ? 'selected' : ''}>${escapeHtml(u.name)} (${escapeHtml(u.role)})</option>`
    );
  }
  select.innerHTML = options.join('');
}

function onEquipFormClientChange() {
  const clientVal = document.getElementById('equip-form-client')?.value || '';
  populateEquipFormUsers(clientVal);
}

function openNewEquipmentModal() {
  const modal = document.getElementById('modal-equipment-form');
  if (!modal) return;

  const form = document.getElementById('form-equipment');
  if (form) form.reset();

  const idInput = document.getElementById('equip-form-id');
  if (idInput) idInput.value = '';

  const titleEl = document.getElementById('equipment-form-modal-title');
  if (titleEl) titleEl.textContent = 'Novo Equipamento no Inventário';

  populateEquipFormClients('');
  populateEquipFormUsers('', '');

  modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeEquipmentModal() {
  const modal = document.getElementById('modal-equipment-form');
  if (modal) modal.classList.add('hidden');
}

function editEquipment(id) {
  const eq = window.db.getEquipmentById ? window.db.getEquipmentById(id) : null;
  if (!eq) {
    showToast('Equipamento não encontrado.', 'error');
    return;
  }

  const modal = document.getElementById('modal-equipment-form');
  if (!modal) return;

  const idInput = document.getElementById('equip-form-id');
  const typeInput = document.getElementById('equip-form-type');
  const nameInput = document.getElementById('equip-form-name');
  const serialInput = document.getElementById('equip-form-serial');
  const notesInput = document.getElementById('equip-form-notes');
  const titleEl = document.getElementById('equipment-form-modal-title');

  if (idInput) idInput.value = eq.id;
  if (typeInput) typeInput.value = eq.type || 'Desktop';
  if (nameInput) nameInput.value = eq.name || '';
  if (serialInput) serialInput.value = eq.serialNumber || '';
  if (notesInput) notesInput.value = eq.notes || '';
  if (titleEl) titleEl.textContent = `Editar Equipamento: ${eq.name}`;

  populateEquipFormClients(eq.clientId || '');
  populateEquipFormUsers(eq.clientId || '', eq.userId || '');

  modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

async function handleSaveEquipment(e) {
  e.preventDefault();

  const id = (document.getElementById('equip-form-id')?.value || '').trim();
  const type = document.getElementById('equip-form-type')?.value || 'Desktop';
  const name = (document.getElementById('equip-form-name')?.value || '').trim();
  const serialNumber = (document.getElementById('equip-form-serial')?.value || '').trim().toUpperCase();
  const clientId = document.getElementById('equip-form-client')?.value || '';
  const userId = document.getElementById('equip-form-user')?.value || '';
  const notes = (document.getElementById('equip-form-notes')?.value || '').trim();

  if (!name) {
    showToast('Informe o nome ou modelo do equipamento.', 'error');
    return;
  }
  if (!serialNumber) {
    showToast('Informe o número de série / identificador do equipamento.', 'error');
    return;
  }

  try {
    if (id) {
      await window.db.updateEquipment(id, {
        name,
        type,
        serialNumber,
        clientId,
        userId,
        notes
      });
      showToast('Equipamento atualizado com sucesso!');
    } else {
      await window.db.addEquipment({
        name,
        type,
        serialNumber,
        clientId,
        userId,
        notes
      });
      showToast('Equipamento adicionado ao inventário com sucesso!');
    }
    closeEquipmentModal();
    refreshAllViews();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteEquipmentConfirm(id) {
  const session = window.db.getSession();
  if (session?.role !== 'ADMIN') {
    showToast('Apenas administradores podem excluir equipamentos do inventário.', 'error');
    return;
  }

  const eq = window.db.getEquipmentById ? window.db.getEquipmentById(id) : null;
  const name = eq ? eq.name : 'este equipamento';

  if (!confirm(`Tem certeza que deseja excluir "${name}" do inventário? Os chamados existentes permanecerão com o registro histórico.`)) {
    return;
  }

  try {
    await window.db.deleteEquipment(id);
    showToast('Equipamento removido do inventário.');
    refreshAllViews();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openEquipmentHistory(equipmentId) {
  const eq = window.db.getEquipmentById ? window.db.getEquipmentById(equipmentId) : null;
  if (!eq) {
    showToast('Equipamento não encontrado.', 'error');
    return;
  }

  const modal = document.getElementById('modal-equipment-history');
  if (!modal) return;

  const titleEl = document.getElementById('equip-history-title');
  const metaEl = document.getElementById('equip-history-meta');
  const typeEl = document.getElementById('equip-history-type');
  const clientEl = document.getElementById('equip-history-client');
  const userEl = document.getElementById('equip-history-user');
  const countEl = document.getElementById('equip-history-count');
  const timelineEl = document.getElementById('equip-history-timeline');

  const clients = window.db.getClients ? window.db.getClients() : [];
  const users = window.db.getUsers ? window.db.getUsers() : [];
  const client = clients.find((c) => c.id === eq.clientId);
  const user = users.find((u) => u.id === eq.userId);

  if (titleEl) titleEl.textContent = eq.name;
  if (metaEl) metaEl.textContent = `Nº de Série: ${eq.serialNumber || 'N/A'}`;
  if (typeEl) typeEl.textContent = eq.type || 'Equipamento';
  if (clientEl) clientEl.textContent = client ? client.name : 'Geral / Sem Cliente';
  if (userEl) userEl.textContent = user ? user.name : 'Não atribuído';

  // Busca todos os chamados deste equipamento (por id ou serial para compatibilidade)
  const allTickets = window.db.getTickets ? window.db.getTickets() : [];
  const histTickets = allTickets.filter(
    (t) => t.equipmentId === equipmentId || (t.equipmentSerial && t.equipmentSerial === eq.serialNumber)
  );

  // Ordena pelo mais recente
  histTickets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (countEl) countEl.textContent = `${histTickets.length} chamado(s)`;

  if (!timelineEl) return;

  if (histTickets.length === 0) {
    timelineEl.innerHTML = `
      <div class="p-8 text-center bg-slate-50 rounded-xl border border-dashed border-slate-200">
        <i data-lucide="check-circle" class="w-8 h-8 text-emerald-500 mx-auto mb-2"></i>
        <p class="text-xs font-semibold text-slate-700">Nenhum chamado registrado para este equipamento</p>
        <p class="text-[11px] text-slate-400 mt-1">Quando novos chamados forem abertos para este ativo, o histórico completo aparecerá aqui.</p>
      </div>
    `;
  } else {
    timelineEl.innerHTML = histTickets
      .map((t) => {
        const prob = window.db.getProblemTypes().find((p) => p.id === t.problemTypeId);
        const probName = prob ? prob.name : 'Suporte Geral';
        const dateStr = new Date(t.createdAt).toLocaleString('pt-BR');
        const resolvedStr = t.resolvedAt ? new Date(t.resolvedAt).toLocaleString('pt-BR') : null;

        const statusColors = {
          ABERTO: 'bg-amber-100 text-amber-800 border-amber-200',
          EM_ATENDIMENTO: 'bg-indigo-100 text-indigo-800 border-indigo-200',
          RESOLVIDO: 'bg-emerald-100 text-emerald-800 border-emerald-200',
          FECHADO: 'bg-slate-100 text-slate-700 border-slate-200'
        };

        return `
          <div class="p-3.5 rounded-xl border border-slate-200 bg-white hover:border-indigo-300 transition-colors">
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-xs font-bold text-slate-900">#${t.id} - ${escapeHtml(t.title)}</span>
                  <span class="px-2 py-0.5 rounded-full text-[10px] font-bold border ${statusColors[t.status] || 'bg-slate-100 text-slate-700'}">
                    ${escapeHtml(t.status)}
                  </span>
                </div>
                <p class="text-xs text-slate-600 line-clamp-2">${escapeHtml(t.description)}</p>
                <div class="flex flex-wrap items-center gap-3 mt-2 text-[11px] text-slate-400">
                  <span><strong class="text-slate-600">Tipo:</strong> ${escapeHtml(probName)}</span>
                  <span><strong class="text-slate-600">Aberto em:</strong> ${dateStr}</span>
                  <span><strong class="text-slate-600">Técnico:</strong> ${escapeHtml(t.technician || 'Não atribuído')}</span>
                  ${resolvedStr ? `<span><strong class="text-emerald-700">Resolvido em:</strong> ${resolvedStr}</span>` : ''}
                </div>
              </div>
              <button
                onclick="closeEquipmentHistoryModal(); openDetailModal('${t.id}');"
                class="px-2.5 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold shrink-0 cursor-pointer transition-colors"
              >
                Ver Chamado
              </button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeEquipmentHistoryModal() {
  const modal = document.getElementById('modal-equipment-history');
  if (modal) modal.classList.add('hidden');
}

// Expõe globalmente no window para compatibilidade com os handlers inline
window.renderInventory = renderInventory;
window.openNewEquipmentModal = openNewEquipmentModal;
window.closeEquipmentModal = closeEquipmentModal;
window.editEquipment = editEquipment;
window.handleSaveEquipment = handleSaveEquipment;
window.deleteEquipmentConfirm = deleteEquipmentConfirm;
window.openEquipmentHistory = openEquipmentHistory;
window.closeEquipmentHistoryModal = closeEquipmentHistoryModal;
window.onEquipFormClientChange = onEquipFormClientChange;
window.goToInventoryFromNewTicketModal = goToInventoryFromNewTicketModal;
window.toggleBusinessDay = toggleBusinessDay;
window.applyBusinessHoursPreset = applyBusinessHoursPreset;
window.updateBusinessHoursCalculations = updateBusinessHoursCalculations;
window.toggleNewTicketEquipMode = toggleNewTicketEquipMode;
window.toggleLunchBreakFields = toggleLunchBreakFields;

// ==========================================
// UTILITÁRIOS
// ==========================================
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  const colors = {
    success: 'bg-slate-900 text-white border-indigo-500',
    error: 'bg-rose-600 text-white border-rose-800',
    info: 'bg-slate-800 text-slate-100 border-slate-600'
  };
  toast.className = `px-4 py-3 rounded-xl shadow-lg border-l-4 text-xs font-semibold flex items-center gap-2 transition-all duration-300 ${
    colors[type] || colors.success
  }`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

