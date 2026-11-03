#!/usr/bin/env python3
"""
Servidor Backend HTTP + Banco de Dados SQLite Relacional (database.db)
Sistema de Chamados Técnicos & SLA para Contrato Fixo.
"""

import json
import os
import sqlite3
import time
from datetime import datetime, timezone, timedelta
from http.server import SimpleHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from urllib.parse import urlparse

DB_PATH = os.environ.get(
    "DB_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "database.db")
)
PORT = int(os.environ.get("PORT", 8080))
HOST = os.environ.get("HOST", "0.0.0.0")


def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    return conn


def init_db():
    """Cria as tabelas no SQLite totalmente zeradas para cadastro do zero."""
    conn = get_conn()
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS contract (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            client_name TEXT DEFAULT '',
            cnpj TEXT DEFAULT '',
            contract_number TEXT DEFAULT '',
            plan_type TEXT DEFAULT 'Contrato Fixo Mensal',
            monthly_hours_quota REAL DEFAULT 0,
            sla_target_percent REAL DEFAULT 95,
            manager_name TEXT DEFAULT '',
            status TEXT DEFAULT 'Ativo',
            admin_user TEXT DEFAULT 'admin',
            admin_password TEXT DEFAULT 'admin123',
            company_name TEXT DEFAULT 'ServiceDesk Pro',
            company_logo TEXT DEFAULT '',
            login_subtitle TEXT DEFAULT 'Portal de Chamados Técnicos & Controle de SLA',
            support_contact TEXT DEFAULT ''
        );
    """)

    # Migração automática de colunas de marca, tema e expediente caso o banco já exista
    existing_cols = [row["name"] for row in cur.execute("PRAGMA table_info(contract);").fetchall()]
    for col_name, default_val in [
        ("company_name", "'ServiceDesk Pro'"),
        ("company_logo", "''"),
        ("login_subtitle", "'Portal de Chamados Técnicos & Controle de SLA'"),
        ("support_contact", "''"),
        ("admin_avatar", "''"),
        ("theme_color", "'indigo'"),
        ("business_hours_start", "'08:00'"),
        ("business_hours_end", "'18:00'"),
        ("business_days", "'1,2,3,4,5'")
    ]:
        if col_name not in existing_cols:
            cur.execute(f"ALTER TABLE contract ADD COLUMN {col_name} TEXT DEFAULT {default_val};")

    # Garante que a linha única de configuração do contrato exista (zerada para preenchimento)
    cur.execute("SELECT COUNT(*) as cnt FROM contract WHERE id = 1;")
    if cur.fetchone()["cnt"] == 0:
        cur.execute("""
            INSERT INTO contract (
                id, client_name, cnpj, contract_number, plan_type,
                monthly_hours_quota, sla_target_percent, manager_name, status,
                admin_user, admin_password, company_name, company_logo, login_subtitle, support_contact,
                admin_avatar, theme_color, business_hours_start, business_hours_end, business_days
            ) VALUES (
                1, '', '', '', 'Contrato Fixo Mensal', 0, 95, '', 'Ativo',
                'admin', 'admin123', 'ServiceDesk Pro', '', 'Portal de Chamados Técnicos & Controle de SLA', '',
                '', 'indigo', '08:00', '18:00', '1,2,3,4,5'
            );
        """)

    # Tabela de Clientes de Contrato Fixo (Suporte a Múltiplos Clientes / Contratos)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS clients (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            cnpj TEXT DEFAULT '',
            contract_number TEXT DEFAULT '',
            plan_type TEXT DEFAULT 'Contrato Fixo Mensal',
            monthly_hours_quota REAL DEFAULT 40,
            sla_target_percent REAL DEFAULT 95,
            manager_name TEXT DEFAULT '',
            phone TEXT DEFAULT '',
            status TEXT DEFAULT 'Ativo',
            created_at TEXT NOT NULL
        );
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL DEFAULT '123456',
            phone TEXT DEFAULT '',
            department TEXT NOT NULL,
            role TEXT DEFAULT '',
            access_role TEXT DEFAULT 'USER',
            client_id TEXT DEFAULT '',
            is_vip INTEGER DEFAULT 0,
            is_blocked INTEGER DEFAULT 0,
            must_change_password INTEGER DEFAULT 1,
            avatar TEXT DEFAULT '',
            theme_color TEXT DEFAULT 'indigo',
            created_at TEXT NOT NULL
        );
    """)

    # Migração automática de colunas na tabela users caso já exista
    user_cols = [row["name"] for row in cur.execute("PRAGMA table_info(users);").fetchall()]
    if "access_role" not in user_cols:
        cur.execute("ALTER TABLE users ADD COLUMN access_role TEXT DEFAULT 'USER';")
    if "client_id" not in user_cols:
        cur.execute("ALTER TABLE users ADD COLUMN client_id TEXT DEFAULT '';")
    if "is_blocked" not in user_cols:
        cur.execute("ALTER TABLE users ADD COLUMN is_blocked INTEGER DEFAULT 0;")
    if "must_change_password" not in user_cols:
        cur.execute("ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 1;")
    if "avatar" not in user_cols:
        cur.execute("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT '';")
    if "theme_color" not in user_cols:
        cur.execute("ALTER TABLE users ADD COLUMN theme_color TEXT DEFAULT 'indigo';")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS problem_types (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            default_sla_hours REAL NOT NULL DEFAULT 4,
            first_response_sla_hours REAL NOT NULL DEFAULT 1,
            priority TEXT NOT NULL DEFAULT 'Média',
            description TEXT DEFAULT ''
        );
    """)

    problem_cols = [row["name"] for row in cur.execute("PRAGMA table_info(problem_types);").fetchall()]
    if "first_response_sla_hours" not in problem_cols:
        cur.execute("ALTER TABLE problem_types ADD COLUMN first_response_sla_hours REAL DEFAULT 1.0;")

    # Tabela de Inventário de Equipamentos (com identificação única por número de série)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS equipment (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'Desktop',
            serial_number TEXT NOT NULL,
            client_id TEXT DEFAULT '',
            user_id TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL
        );
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS tickets (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            user_id TEXT NOT NULL,
            client_id TEXT DEFAULT '',
            equipment_id TEXT DEFAULT '',
            problem_type_id TEXT NOT NULL,
            sla_hours REAL NOT NULL,
            first_response_sla_hours REAL DEFAULT 1.0,
            priority TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'Aberto',
            technician TEXT DEFAULT 'Aguardando Direcionamento (Admin)',
            hours_spent REAL DEFAULT 0,
            problem_found TEXT DEFAULT '',
            service_performed TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            assigned_at TEXT,
            started_at TEXT,
            first_response_due_at TEXT,
            first_responded_at TEXT,
            due_at TEXT NOT NULL,
            resolved_at TEXT,
            notes_json TEXT DEFAULT '[]'
        );
    """)

    ticket_cols = [row["name"] for row in cur.execute("PRAGMA table_info(tickets);").fetchall()]
    if "client_id" not in ticket_cols:
        cur.execute("ALTER TABLE tickets ADD COLUMN client_id TEXT DEFAULT '';")
    if "equipment_id" not in ticket_cols:
        cur.execute("ALTER TABLE tickets ADD COLUMN equipment_id TEXT DEFAULT '';")
    if "first_response_sla_hours" not in ticket_cols:
        cur.execute("ALTER TABLE tickets ADD COLUMN first_response_sla_hours REAL DEFAULT 1.0;")
    if "first_response_due_at" not in ticket_cols:
        cur.execute("ALTER TABLE tickets ADD COLUMN first_response_due_at TEXT;")
    if "first_responded_at" not in ticket_cols:
        cur.execute("ALTER TABLE tickets ADD COLUMN first_responded_at TEXT;")
    if "problem_found" not in ticket_cols:
        cur.execute("ALTER TABLE tickets ADD COLUMN problem_found TEXT DEFAULT '';")
    if "service_performed" not in ticket_cols:
        cur.execute("ALTER TABLE tickets ADD COLUMN service_performed TEXT DEFAULT '';")
    if "assigned_at" not in ticket_cols:
        cur.execute("ALTER TABLE tickets ADD COLUMN assigned_at TEXT;")
    if "started_at" not in ticket_cols:
        cur.execute("ALTER TABLE tickets ADD COLUMN started_at TEXT;")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS solutions (
            id TEXT PRIMARY KEY,
            ticket_id TEXT DEFAULT '',
            problem_type_id TEXT DEFAULT '',
            title TEXT NOT NULL,
            problem_found TEXT NOT NULL,
            service_performed TEXT NOT NULL,
            technician TEXT DEFAULT '',
            hours_spent REAL DEFAULT 0,
            attachments_json TEXT DEFAULT '[]',
            created_at TEXT NOT NULL
        );
    """)

    sol_cols = [row["name"] for row in cur.execute("PRAGMA table_info(solutions);").fetchall()]
    if "attachments_json" not in sol_cols:
        cur.execute("ALTER TABLE solutions ADD COLUMN attachments_json TEXT DEFAULT '[]';")

    conn.commit()
    conn.close()


def calculate_business_due(start_dt, sla_hours, start_time_str="08:00", end_time_str="18:00", business_days_str="1,2,3,4,5"):
    """Calcula o prazo limite somando apenas os minutos dentro do horário de expediente comercial configurado."""
    try:
        sh, sm = map(int, (start_time_str or "08:00").split(":"))
        eh, em = map(int, (end_time_str or "18:00").split(":"))
        allowed_days = [int(x.strip()) for x in (business_days_str or "1,2,3,4,5").split(",") if x.strip().isdigit()]
        if not allowed_days:
            allowed_days = [1, 2, 3, 4, 5]
    except Exception:
        sh, sm, eh, em, allowed_days = 8, 0, 18, 0, [1, 2, 3, 4, 5]

    curr = start_dt
    if curr.tzinfo is None:
        curr = curr.replace(tzinfo=timezone.utc)

    remaining_minutes = int(float(sla_hours) * 60)
    max_steps = 60 * 24 * 60
    step = 0

    while remaining_minutes > 0 and step < max_steps:
        iso_day = curr.isoweekday()  # 1=Segunda, ..., 7=Domingo
        curr_min = curr.hour * 60 + curr.minute
        open_min = sh * 60 + sm
        close_min = eh * 60 + em

        if iso_day in allowed_days and open_min <= curr_min < close_min:
            avail_today = close_min - curr_min
            take = min(remaining_minutes, avail_today)
            curr += timedelta(minutes=take)
            remaining_minutes -= take
            step += take
        else:
            if iso_day in allowed_days and curr_min < open_min:
                curr = curr.replace(hour=sh, minute=sm, second=0, microsecond=0)
            else:
                curr = (curr + timedelta(days=1)).replace(hour=sh, minute=sm, second=0, microsecond=0)
            step += 1

    return curr


def fetch_full_state():
    conn = get_conn()
    cur = conn.cursor()

    cur.execute("SELECT * FROM contract WHERE id = 1;")
    c_row = cur.fetchone()
    contract = {
        "clientName": c_row["client_name"],
        "cnpj": c_row["cnpj"],
        "contractNumber": c_row["contract_number"],
        "planType": c_row["plan_type"],
        "monthlyHoursQuota": c_row["monthly_hours_quota"],
        "slaTargetPercent": c_row["sla_target_percent"],
        "managerName": c_row["manager_name"],
        "status": c_row["status"],
        "adminUser": c_row["admin_user"] or "admin",
        "adminPassword": c_row["admin_password"] or "admin123",
        "companyName": c_row["company_name"] or "ServiceDesk Pro",
        "companyLogo": c_row["company_logo"] or "",
        "loginSubtitle": c_row["login_subtitle"] or "Portal de Chamados Técnicos & Controle de SLA",
        "supportContact": c_row["support_contact"] or "",
        "adminAvatar": c_row["admin_avatar"] if "admin_avatar" in c_row.keys() else "",
        "themeColor": (c_row["theme_color"] if "theme_color" in c_row.keys() else "indigo") or "indigo",
        "businessHoursStart": (c_row["business_hours_start"] if "business_hours_start" in c_row.keys() else "08:00") or "08:00",
        "businessHoursEnd": (c_row["business_hours_end"] if "business_hours_end" in c_row.keys() else "18:00") or "18:00",
        "businessDays": (c_row["business_days"] if "business_days" in c_row.keys() else "1,2,3,4,5") or "1,2,3,4,5"
    }

    cur.execute("SELECT * FROM clients ORDER BY created_at DESC;")
    clients = [
        {
            "id": r["id"],
            "name": r["name"],
            "cnpj": r["cnpj"] or "",
            "contractNumber": r["contract_number"] or "",
            "planType": r["plan_type"] or "Contrato Fixo Mensal",
            "monthlyHoursQuota": float(r["monthly_hours_quota"] or 0),
            "slaTargetPercent": float(r["sla_target_percent"] or 95),
            "managerName": r["manager_name"] or "",
            "phone": r["phone"] or "",
            "status": r["status"] or "Ativo",
            "createdAt": r["created_at"]
        }
        for r in cur.fetchall()
    ]

    cur.execute("SELECT * FROM equipment ORDER BY created_at DESC;")
    equipment = [
        {
            "id": r["id"],
            "name": r["name"],
            "type": r["type"],
            "serialNumber": r["serial_number"],
            "clientId": (r["client_id"] if "client_id" in r.keys() else "") or "",
            "userId": (r["user_id"] if "user_id" in r.keys() else "") or "",
            "notes": (r["notes"] if "notes" in r.keys() else "") or "",
            "createdAt": r["created_at"]
        }
        for r in cur.fetchall()
    ]

    cur.execute("SELECT * FROM users ORDER BY created_at DESC;")
    users = [
        {
            "id": r["id"],
            "name": r["name"],
            "email": r["email"],
            "password": r["password"],
            "phone": r["phone"],
            "department": r["department"],
            "role": r["role"],
            "accessRole": r["access_role"] or "USER",
            "clientId": (r["client_id"] if "client_id" in r.keys() else "") or "",
            "isVip": bool(r["is_vip"]),
            "isBlocked": bool(r["is_blocked"]) if "is_blocked" in r.keys() else False,
            "mustChangePassword": bool(r["must_change_password"]) if "must_change_password" in r.keys() and r["must_change_password"] is not None else True,
            "avatar": (r["avatar"] if "avatar" in r.keys() else "") or "",
            "themeColor": (r["theme_color"] if "theme_color" in r.keys() else "indigo") or "indigo",
            "createdAt": r["created_at"]
        }
        for r in cur.fetchall()
    ]

    cur.execute("SELECT * FROM problem_types ORDER BY rowid ASC;")
    problem_types = [
        {
            "id": r["id"],
            "name": r["name"],
            "category": r["category"],
            "defaultSlaHours": r["default_sla_hours"],
            "firstResponseSlaHours": float(r["first_response_sla_hours"] if "first_response_sla_hours" in r.keys() and r["first_response_sla_hours"] is not None else 1.0),
            "priority": r["priority"],
            "description": r["description"]
        }
        for r in cur.fetchall()
    ]

    cur.execute("SELECT * FROM tickets ORDER BY created_at DESC;")
    tickets = [
        {
            "id": r["id"],
            "title": r["title"],
            "description": r["description"],
            "userId": r["user_id"],
            "clientId": (r["client_id"] if "client_id" in r.keys() else "") or "",
            "equipmentId": (r["equipment_id"] if "equipment_id" in r.keys() else "") or "",
            "problemTypeId": r["problem_type_id"],
            "slaHours": r["sla_hours"],
            "firstResponseSlaHours": float(r["first_response_sla_hours"] if "first_response_sla_hours" in r.keys() and r["first_response_sla_hours"] is not None else 1.0),
            "priority": r["priority"],
            "status": r["status"],
            "technician": r["technician"],
            "hoursSpent": r["hours_spent"],
            "problemFound": (r["problem_found"] if "problem_found" in r.keys() else "") or "",
            "servicePerformed": (r["service_performed"] if "service_performed" in r.keys() else "") or "",
            "createdAt": r["created_at"],
            "assignedAt": r["assigned_at"] if "assigned_at" in r.keys() else None,
            "startedAt": r["started_at"] if "started_at" in r.keys() else None,
            "firstResponseDueAt": r["first_response_due_at"] if "first_response_due_at" in r.keys() else None,
            "firstRespondedAt": r["first_responded_at"] if "first_responded_at" in r.keys() else None,
            "dueAt": r["due_at"],
            "resolvedAt": r["resolved_at"],
            "notes": json.loads(r["notes_json"] or "[]")
        }
        for r in cur.fetchall()
    ]

    cur.execute("SELECT * FROM solutions ORDER BY created_at DESC;")
    solutions = [
        {
            "id": r["id"],
            "ticketId": r["ticket_id"] or "",
            "problemTypeId": r["problem_type_id"] or "",
            "title": r["title"],
            "problemFound": r["problem_found"],
            "servicePerformed": r["service_performed"],
            "technician": r["technician"] or "",
            "hoursSpent": float(r["hours_spent"] or 0),
            "attachments": json.loads((r["attachments_json"] if "attachments_json" in r.keys() else "[]") or "[]"),
            "createdAt": r["created_at"]
        }
        for r in cur.fetchall()
    ]

    conn.close()
    return {
        "contract": contract,
        "clients": clients,
        "users": users,
        "equipment": equipment,
        "problemTypes": problem_types,
        "tickets": tickets,
        "solutions": solutions
    }


class AppRequestHandler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Evita poluir o log com o polling em tempo real de /api/state
        if self.command == "GET" and self.path.startswith("/api/state"):
            return
        super().log_message(fmt, *args)

    def _send_json(self, data, status=200):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            self._send_json(fetch_full_state())
            return
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        body = self._read_json()
        conn = get_conn()
        cur = conn.cursor()

        try:
            # 1. LOGIN (Admin, Técnico ou Usuário Comum — Aceita Login/E-mail ou Nome)
            if parsed.path == "/api/auth/login":
                identifier = (body.get("identifier") or "").strip()
                password = (body.get("password") or "").strip()

                cur.execute("SELECT * FROM contract WHERE id = 1;")
                c_row = cur.fetchone()
                admin_user_cfg = (c_row["admin_user"] or "admin").strip().lower()
                admin_pass_cfg = (c_row["admin_password"] or "admin123").strip()

                if identifier.lower() in (admin_user_cfg, "admin", "admin@admin.com") and password in (admin_pass_cfg, "admin123"):
                    self._send_json({
                        "ok": True,
                        "session": {
                            "role": "ADMIN",
                            "name": "Administrador Geral",
                            "email": c_row["admin_user"] or "admin",
                            "department": "Diretoria / Gestão TI",
                            "userId": None,
                            "clientId": "",
                            "mustChangePassword": False,
                            "avatar": c_row["admin_avatar"] or "",
                            "themeColor": c_row["theme_color"] or "indigo"
                        }
                    })
                    return

                cur.execute(
                    "SELECT * FROM users WHERE (LOWER(email) = LOWER(?) OR LOWER(name) = LOWER(?)) AND password = ?;",
                    (identifier, identifier, password)
                )
                u_row = cur.fetchone()
                if u_row:
                    if bool(u_row["is_blocked"]):
                        self._send_json({
                            "ok": False,
                            "error": "Acesso bloqueado pelo Administrador. Entre em contato com a gestão do contrato."
                        }, 403)
                        return

                    user_access_role = u_row["access_role"] if u_row["access_role"] in ("ADMIN", "TECH", "USER") else "USER"
                    must_change = bool(u_row["must_change_password"]) if "must_change_password" in u_row.keys() and u_row["must_change_password"] is not None else True
                    self._send_json({
                        "ok": True,
                        "session": {
                            "role": user_access_role,
                            "userId": u_row["id"],
                            "clientId": (u_row["client_id"] if "client_id" in u_row.keys() else "") or "",
                            "name": u_row["name"],
                            "email": u_row["email"],
                            "phone": u_row["phone"] or "",
                            "department": u_row["department"],
                            "jobRole": u_row["role"],
                            "isVip": bool(u_row["is_vip"]),
                            "mustChangePassword": must_change,
                            "avatar": u_row["avatar"] or "",
                            "themeColor": u_row["theme_color"] or c_row["theme_color"] or "indigo"
                        }
                    })
                    return

                self._send_json({"ok": False, "error": "Credenciais inválidas. Verifique seu login/e-mail e senha."}, 401)
                return

            # 1B. RESETAR TODAS AS SENHAS (ADMIN -> admin123, USUÁRIOS -> 123456 + DESBLOQUEAR)
            if parsed.path == "/api/auth/reset-passwords":
                cur.execute("UPDATE contract SET admin_user = 'admin', admin_password = 'admin123' WHERE id = 1;")
                cur.execute("UPDATE users SET password = '123456', is_blocked = 0, must_change_password = 1;")
                conn.commit()
                self._send_json({"ok": True, "state": fetch_full_state()})
                return

            # 2. ATUALIZAR CONTRATO PADRÃO E IDENTIDADE VISUAL (LOGO DA EMPRESA E HORÁRIO DE EXPEDIENTE)
            if parsed.path == "/api/contract":
                cur.execute("SELECT * FROM contract WHERE id = 1;")
                curr = cur.fetchone()
                cur.execute("""
                    UPDATE contract SET
                        client_name = ?,
                        cnpj = ?,
                        contract_number = ?,
                        monthly_hours_quota = ?,
                        sla_target_percent = ?,
                        manager_name = ?,
                        company_name = ?,
                        company_logo = ?,
                        login_subtitle = ?,
                        support_contact = ?,
                        admin_avatar = ?,
                        theme_color = ?,
                        business_hours_start = ?,
                        business_hours_end = ?,
                        business_days = ?
                    WHERE id = 1;
                """, (
                    body.get("clientName", curr["client_name"]),
                    body.get("cnpj", curr["cnpj"]),
                    body.get("contractNumber", curr["contract_number"]),
                    float(body.get("monthlyHoursQuota", curr["monthly_hours_quota"]) or 0),
                    float(body.get("slaTargetPercent", curr["sla_target_percent"]) or 95),
                    body.get("managerName", curr["manager_name"]),
                    body.get("companyName", curr["company_name"] or "ServiceDesk Pro"),
                    body.get("companyLogo", curr["company_logo"] or ""),
                    body.get("loginSubtitle", curr["login_subtitle"] or "Portal de Chamados Técnicos & Controle de SLA"),
                    body.get("supportContact", curr["support_contact"] or ""),
                    body.get("adminAvatar", curr["admin_avatar"] or ""),
                    body.get("themeColor", curr["theme_color"] or "indigo"),
                    (body.get("businessHoursStart") if "businessHoursStart" in body else (curr["business_hours_start"] if "business_hours_start" in curr.keys() else "08:00")) or "08:00",
                    (body.get("businessHoursEnd") if "businessHoursEnd" in body else (curr["business_hours_end"] if "business_hours_end" in curr.keys() else "18:00")) or "18:00",
                    (body.get("businessDays") if "businessDays" in body else (curr["business_days"] if "business_days" in curr.keys() else "1,2,3,4,5")) or "1,2,3,4,5"
                ))
                if body.get("adminPassword"):
                    cur.execute("UPDATE contract SET admin_password = ? WHERE id = 1;", (body["adminPassword"],))
                conn.commit()
                self._send_json({"ok": True, "state": fetch_full_state()})
                return

            # 2B. CADASTRAR NOVO CLIENTE DE CONTRATO FIXO (MÚLTIPLOS CLIENTES)
            if parsed.path == "/api/clients":
                cid = "cli-" + str(int(time.time() * 1000))
                now_iso = datetime.now(timezone.utc).isoformat()
                cur.execute("""
                    INSERT INTO clients (
                        id, name, cnpj, contract_number, plan_type,
                        monthly_hours_quota, sla_target_percent, manager_name, phone, status, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
                """, (
                    cid,
                    body["name"].strip(),
                    (body.get("cnpj") or "").strip(),
                    (body.get("contractNumber") or "").strip(),
                    (body.get("planType") or "Contrato Fixo Mensal").strip(),
                    float(body.get("monthlyHoursQuota") or 40),
                    float(body.get("slaTargetPercent") or 95),
                    (body.get("managerName") or "").strip(),
                    (body.get("phone") or "").strip(),
                    body.get("status") or "Ativo",
                    now_iso
                ))
                conn.commit()
                self._send_json({"ok": True, "clientId": cid, "state": fetch_full_state()})
                return

            # 2C. EDITAR / ATUALIZAR CLIENTE DE CONTRATO FIXO
            if parsed.path == "/api/clients/update":
                cid = body.get("id")
                cur.execute("SELECT * FROM clients WHERE id = ?;", (cid,))
                c_row = cur.fetchone()
                if not c_row:
                    self._send_json({"ok": False, "error": "Cliente de contrato não encontrado."}, 404)
                    return

                cur.execute("""
                    UPDATE clients SET
                        name = ?,
                        cnpj = ?,
                        contract_number = ?,
                        plan_type = ?,
                        monthly_hours_quota = ?,
                        sla_target_percent = ?,
                        manager_name = ?,
                        phone = ?,
                        status = ?
                    WHERE id = ?;
                """, (
                    (body.get("name") or c_row["name"]).strip(),
                    (body.get("cnpj") if "cnpj" in body else (c_row["cnpj"] or "")).strip(),
                    (body.get("contractNumber") if "contractNumber" in body else (c_row["contract_number"] or "")).strip(),
                    (body.get("planType") or c_row["plan_type"] or "Contrato Fixo Mensal").strip(),
                    float(body.get("monthlyHoursQuota") if "monthlyHoursQuota" in body and body["monthlyHoursQuota"] is not None else c_row["monthly_hours_quota"]),
                    float(body.get("slaTargetPercent") if "slaTargetPercent" in body and body["slaTargetPercent"] is not None else c_row["sla_target_percent"]),
                    (body.get("managerName") if "managerName" in body else (c_row["manager_name"] or "")).strip(),
                    (body.get("phone") if "phone" in body else (c_row["phone"] or "")).strip(),
                    body.get("status") or c_row["status"] or "Ativo",
                    cid
                ))
                conn.commit()
                self._send_json({"ok": True, "state": fetch_full_state()})
                return

            # 3. CADASTRAR USUÁRIO (ADMIN, TÉCNICO OU USUÁRIO COMUM + CLIENTE VINCULADO + TROCA SENHA 1º ACESSO)
            if parsed.path == "/api/users":
                uid = "usr-" + str(int(time.time() * 1000))
                now_iso = datetime.now(timezone.utc).isoformat()
                access_role = body.get("accessRole", "USER")
                if access_role not in ("ADMIN", "TECH", "USER"):
                    access_role = "USER"

                must_change = 1 if body.get("mustChangePassword", True) else 0

                cur.execute("""
                    INSERT INTO users (
                        id, name, email, password, phone, department, role,
                        access_role, client_id, is_vip, is_blocked, must_change_password, avatar, theme_color, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
                """, (
                    uid,
                    body["name"].strip(),
                    body["email"].strip().lower(),
                    (body.get("password") or "123456").strip(),
                    (body.get("phone") or "").strip(),
                    body["department"].strip(),
                    (body.get("role") or "").strip(),
                    access_role,
                    (body.get("clientId") or "").strip(),
                    1 if body.get("isVip") else 0,
                    1 if body.get("isBlocked") else 0,
                    must_change,
                    body.get("avatar") or "",
                    body.get("themeColor") or "indigo",
                    now_iso
                ))
                conn.commit()
                self._send_json({"ok": True, "userId": uid, "state": fetch_full_state()})
                return

            # 3B. ATUALIZAR / GERENCIAR USUÁRIO PELO ADMIN (EDIÇÃO, BLOQUEIO, DESBLOQUEIO DE SENHA, CLIENTE)
            if parsed.path == "/api/users/update":
                uid = body.get("id")
                cur.execute("SELECT * FROM users WHERE id = ?;", (uid,))
                u_row = cur.fetchone()
                if not u_row:
                    self._send_json({"ok": False, "error": "Usuário não encontrado."}, 404)
                    return

                access_role = body.get("accessRole", u_row["access_role"] or "USER")
                if access_role not in ("ADMIN", "TECH", "USER"):
                    access_role = "USER"

                new_pass = (body.get("password") or "").strip() or u_row["password"]
                is_vip = 1 if body.get("isVip", bool(u_row["is_vip"])) else 0
                is_blocked = 1 if body.get("isBlocked", bool(u_row["is_blocked"])) else 0

                curr_must_change = bool(u_row["must_change_password"]) if "must_change_password" in u_row.keys() and u_row["must_change_password"] is not None else True
                must_change = 1 if body.get("mustChangePassword", curr_must_change) else 0

                cur.execute("""
                    UPDATE users SET
                        name = ?,
                        email = ?,
                        password = ?,
                        phone = ?,
                        department = ?,
                        role = ?,
                        access_role = ?,
                        client_id = ?,
                        is_vip = ?,
                        is_blocked = ?,
                        must_change_password = ?,
                        avatar = ?,
                        theme_color = ?
                    WHERE id = ?;
                """, (
                    (body.get("name") or u_row["name"]).strip(),
                    (body.get("email") or u_row["email"]).strip().lower(),
                    new_pass,
                    (body.get("phone") if "phone" in body else (u_row["phone"] or "")).strip(),
                    (body.get("department") or u_row["department"]).strip(),
                    (body.get("role") if "role" in body else (u_row["role"] or "")).strip(),
                    access_role,
                    (body.get("clientId") if "clientId" in body else (u_row["client_id"] or "")).strip(),
                    is_vip,
                    is_blocked,
                    must_change,
                    body.get("avatar", u_row["avatar"] or ""),
                    body.get("themeColor", u_row["theme_color"] or "indigo"),
                    uid
                ))
                conn.commit()
                self._send_json({"ok": True, "state": fetch_full_state()})
                return

            # 3C. ATUALIZAR MEU PERFIL & CONFIGURAÇÕES (COR DO TEMA, FOTO DE PERFIL, TROCA DE SENHA)
            if parsed.path == "/api/profile/update":
                user_id = body.get("userId")
                current_password = (body.get("currentPassword") or "").strip()
                new_password = (body.get("newPassword") or "").strip()
                theme_color = body.get("themeColor")
                avatar = body.get("avatar")
                name = body.get("name")
                phone = body.get("phone")

                # Caso seja o Administrador Mestre (sem userId na tabela users)
                if not user_id:
                    cur.execute("SELECT * FROM contract WHERE id = 1;")
                    c_row = cur.fetchone()
                    if new_password:
                        if current_password and current_password != c_row["admin_password"]:
                            self._send_json({"ok": False, "error": "A senha atual do Administrador está incorreta."}, 400)
                            return
                        cur.execute("UPDATE contract SET admin_password = ? WHERE id = 1;", (new_password,))
                    if avatar is not None:
                        cur.execute("UPDATE contract SET admin_avatar = ? WHERE id = 1;", (avatar,))
                    if theme_color:
                        cur.execute("UPDATE contract SET theme_color = ? WHERE id = 1;", (theme_color,))
                    conn.commit()
                    self._send_json({"ok": True, "state": fetch_full_state()})
                    return

                # Usuário cadastrado na tabela users (Admin cadastrado, Técnico ou Usuário Comum)
                cur.execute("SELECT * FROM users WHERE id = ?;", (user_id,))
                u_row = cur.fetchone()
                if not u_row:
                    self._send_json({"ok": False, "error": "Perfil de usuário não encontrado."}, 404)
                    return

                if new_password:
                    if current_password and current_password != u_row["password"]:
                        self._send_json({"ok": False, "error": "Sua senha atual está incorreta."}, 400)
                        return
                    cur.execute(
                        "UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?;",
                        (new_password, user_id)
                    )

                if avatar is not None:
                    cur.execute("UPDATE users SET avatar = ? WHERE id = ?;", (avatar, user_id))
                if theme_color:
                    cur.execute("UPDATE users SET theme_color = ? WHERE id = ?;", (theme_color, user_id))
                if name:
                    cur.execute("UPDATE users SET name = ? WHERE id = ?;", (name.strip(), user_id))
                if phone is not None:
                    cur.execute("UPDATE users SET phone = ? WHERE id = ?;", (phone.strip(), user_id))

                conn.commit()
                self._send_json({"ok": True, "state": fetch_full_state()})
                return

            # 4. CADASTRAR TIPO DE PROBLEMA & SLA (SLA DE RESOLUÇÃO + SLA DE PRIMEIRA RESPOSTA)
            if parsed.path == "/api/problems":
                pid = "prb-" + str(int(time.time() * 1000))
                cur.execute("""
                    INSERT INTO problem_types (id, name, category, default_sla_hours, first_response_sla_hours, priority, description)
                    VALUES (?, ?, ?, ?, ?, ?, ?);
                """, (
                    pid,
                    body["name"].strip(),
                    body["category"].strip(),
                    float(body.get("defaultSlaHours") or 4),
                    float(body.get("firstResponseSlaHours") or 1),
                    body.get("priority", "Média"),
                    (body.get("description") or "").strip()
                ))
                conn.commit()
                self._send_json({"ok": True, "problemId": pid, "state": fetch_full_state()})
                return

            # 4B. CADASTRAR / VINCULAR EQUIPAMENTO NO INVENTÁRIO (COM DEDUPLICAÇÃO POR NÚMERO DE SÉRIE)
            if parsed.path == "/api/equipment":
                name = (body.get("name") or "").strip()
                eq_type = (body.get("type") or "Desktop").strip()
                serial = (body.get("serialNumber") or "").strip().upper()
                client_id = (body.get("clientId") or "").strip()
                user_id = (body.get("userId") or "").strip()
                notes = (body.get("notes") or "").strip()
                now_iso = datetime.now(timezone.utc).isoformat()

                if not serial:
                    self._send_json({"ok": False, "error": "Número de série do equipamento é obrigatório."}, 400)
                    return

                # Deduplicação: verifica se já existe equipamento cadastrado com o mesmo número de série
                cur.execute("SELECT * FROM equipment WHERE UPPER(serial_number) = ?;", (serial,))
                existing = cur.fetchone()

                if existing:
                    # Já existe no inventário: atualiza dados complementares e reutiliza o mesmo ID para evitar duplicidade
                    eq_id = existing["id"]
                    cur.execute("""
                        UPDATE equipment SET
                            name = CASE WHEN ? != '' THEN ? ELSE name END,
                            type = CASE WHEN ? != '' THEN ? ELSE type END,
                            client_id = CASE WHEN ? != '' THEN ? ELSE client_id END,
                            user_id = CASE WHEN ? != '' THEN ? ELSE user_id END,
                            notes = CASE WHEN ? != '' THEN ? ELSE notes END
                        WHERE id = ?;
                    """, (name, name, eq_type, eq_type, client_id, client_id, user_id, user_id, notes, notes, eq_id))
                    conn.commit()
                    self._send_json({"ok": True, "equipmentId": eq_id, "reused": True, "state": fetch_full_state()})
                    return

                # Novo equipamento
                eq_id = "eq-" + str(int(time.time() * 1000))
                cur.execute("""
                    INSERT INTO equipment (id, name, type, serial_number, client_id, user_id, notes, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                """, (eq_id, name or f"Equipamento {eq_type}", eq_type, serial, client_id, user_id, notes, now_iso))
                conn.commit()
                self._send_json({"ok": True, "equipmentId": eq_id, "reused": False, "state": fetch_full_state()})
                return

            # 4C. ATUALIZAR / EDITAR EQUIPAMENTO NO INVENTÁRIO
            if parsed.path == "/api/equipment/update":
                eq_id = body.get("id")
                cur.execute("SELECT * FROM equipment WHERE id = ?;", (eq_id,))
                eq_row = cur.fetchone()
                if not eq_row:
                    self._send_json({"ok": False, "error": "Equipamento não encontrado."}, 404)
                    return

                new_serial = (body.get("serialNumber") or eq_row["serial_number"]).strip().upper()
                cur.execute("""
                    UPDATE equipment SET
                        name = ?,
                        type = ?,
                        serial_number = ?,
                        client_id = ?,
                        user_id = ?,
                        notes = ?
                    WHERE id = ?;
                """, (
                    (body.get("name") or eq_row["name"]).strip(),
                    (body.get("type") or eq_row["type"]).strip(),
                    new_serial,
                    (body.get("clientId") if "clientId" in body else (eq_row["client_id"] or "")).strip(),
                    (body.get("userId") if "userId" in body else (eq_row["user_id"] or "")).strip(),
                    (body.get("notes") if "notes" in body else (eq_row["notes"] or "")).strip(),
                    eq_id
                ))
                conn.commit()
                self._send_json({"ok": True, "state": fetch_full_state()})
                return

            # 5. ABRIR NOVO CHAMADO (COM EQUIPAMENTO + SLA EM DIAS E HORAS ÚTEIS DE EXPEDIENTE)
            if parsed.path == "/api/tickets":
                cur.execute("SELECT COUNT(*) as cnt FROM tickets;")
                next_num = 1001 + cur.fetchone()["cnt"]
                tid = f"CH-{next_num}"
                now = datetime.now(timezone.utc)

                # Busca expediente configurado no contrato
                cur.execute("SELECT business_hours_start, business_hours_end, business_days FROM contract WHERE id = 1;")
                cfg_row = cur.fetchone()
                bh_start = (cfg_row["business_hours_start"] if cfg_row and "business_hours_start" in cfg_row.keys() else "08:00") or "08:00"
                bh_end = (cfg_row["business_hours_end"] if cfg_row and "business_hours_end" in cfg_row.keys() else "18:00") or "18:00"
                bh_days = (cfg_row["business_days"] if cfg_row and "business_days" in cfg_row.keys() else "1,2,3,4,5") or "1,2,3,4,5"

                # Se clientId não veio no body, herda do usuário solicitante
                client_id = (body.get("clientId") or "").strip()
                if not client_id and body.get("userId"):
                    cur.execute("SELECT client_id FROM users WHERE id = ?;", (body["userId"],))
                    ur = cur.fetchone()
                    if ur and ur["client_id"]:
                        client_id = ur["client_id"]

                # Tratamento de Equipamento: Se veio um novo equipamento no corpo do chamado, cadastra ou deduplica
                equipment_id = (body.get("equipmentId") or "").strip()
                new_equip_obj = body.get("newEquipment")
                if isinstance(new_equip_obj, dict) and new_equip_obj.get("serialNumber"):
                    eq_serial = new_equip_obj.get("serialNumber", "").strip().upper()
                    cur.execute("SELECT id FROM equipment WHERE UPPER(serial_number) = ?;", (eq_serial,))
                    eq_found = cur.fetchone()
                    if eq_found:
                        equipment_id = eq_found["id"]
                    else:
                        equipment_id = "eq-" + str(int(time.time() * 1000))
                        eq_name = new_equip_obj.get("name", "").strip() or f"Equipamento {new_equip_obj.get('type', 'Desktop')}"
                        cur.execute("""
                            INSERT INTO equipment (id, name, type, serial_number, client_id, user_id, notes, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                        """, (
                            equipment_id,
                            eq_name,
                            new_equip_obj.get("type", "Desktop"),
                            eq_serial,
                            client_id,
                            body.get("userId") or "",
                            new_equip_obj.get("notes", "") or "Cadastrado via chamado " + tid,
                            now.isoformat()
                        ))

                # Prazos SLA calculados em horas úteis de expediente
                sla_hours = float(body.get("slaHours") or 4)
                first_resp_sla = float(body.get("firstResponseSlaHours") or 1.0)
                if not body.get("firstResponseSlaHours") and body.get("problemTypeId"):
                    cur.execute("SELECT first_response_sla_hours FROM problem_types WHERE id = ?;", (body["problemTypeId"],))
                    prb_row = cur.fetchone()
                    if prb_row and "first_response_sla_hours" in prb_row.keys() and prb_row["first_response_sla_hours"]:
                        first_resp_sla = float(prb_row["first_response_sla_hours"])

                due_dt_str = body.get("dueAt")
                first_resp_due_str = body.get("firstResponseDueAt")

                if not due_dt_str:
                    due_dt = calculate_business_due(now, sla_hours, bh_start, bh_end, bh_days)
                    due_dt_str = due_dt.isoformat()

                if not first_resp_due_str:
                    first_resp_due_dt = calculate_business_due(now, first_resp_sla, bh_start, bh_end, bh_days)
                    first_resp_due_str = first_resp_due_dt.isoformat()

                tech_val = (body.get("technician") or "Aguardando Direcionamento (Admin)").strip()
                is_assigned = tech_val.lower() not in ("", "aguardando direcionamento (admin)", "aguardando atribuição", "não atribuído")
                assigned_at = now.isoformat() if is_assigned else None
                started_at = None
                first_responded_at = None

                cur.execute("""
                    INSERT INTO tickets (
                        id, title, description, user_id, client_id, equipment_id, problem_type_id,
                        sla_hours, first_response_sla_hours, priority, status, technician, hours_spent,
                        created_at, assigned_at, started_at, first_response_due_at, first_responded_at, due_at, resolved_at, notes_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Aberto', ?, 0, ?, ?, ?, ?, ?, ?, NULL, '[]');
                """, (
                    tid,
                    body["title"].strip(),
                    body["description"].strip(),
                    body["userId"],
                    client_id,
                    equipment_id,
                    body["problemTypeId"],
                    sla_hours,
                    first_resp_sla,
                    body.get("priority", "Média"),
                    tech_val,
                    now.isoformat(),
                    assigned_at,
                    started_at,
                    first_resp_due_str,
                    first_responded_at,
                    due_dt_str
                ))
                conn.commit()
                self._send_json({"ok": True, "ticketId": tid, "state": fetch_full_state()})
                return

            # 6. ATUALIZAR / EDITAR / FINALIZAR CHAMADO (STATUS, TÉCNICO, HORAS, PROBLEMA ENCONTRADO, SERVIÇO REALIZADO + BANCO DE SOLUÇÕES)
            if parsed.path == "/api/tickets/update":
                tid = body["id"]
                cur.execute("SELECT * FROM tickets WHERE id = ?;", (tid,))
                row = cur.fetchone()
                if not row:
                    self._send_json({"ok": False, "error": "Chamado não encontrado"}, 404)
                    return

                new_title = (body.get("title") or row["title"]).strip()
                new_desc = (body.get("description") or row["description"]).strip()
                new_user_id = body.get("userId") or row["user_id"]
                new_client_id = body.get("clientId") if "clientId" in body else (row["client_id"] or "")
                new_equip_id = body.get("equipmentId") if "equipmentId" in body else ((row["equipment_id"] if "equipment_id" in row.keys() else "") or "")
                new_prob_id = body.get("problemTypeId") or row["problem_type_id"]
                new_priority = body.get("priority") or row["priority"]
                new_sla_hours = float(body.get("slaHours") if "slaHours" in body and body["slaHours"] is not None else row["sla_hours"])

                # Busca configurações de expediente para recalcular vencimento em horas úteis
                cur.execute("SELECT business_hours_start, business_hours_end, business_days FROM contract WHERE id = 1;")
                cfg_row = cur.fetchone()
                bh_start = (cfg_row["business_hours_start"] if cfg_row and "business_hours_start" in cfg_row.keys() else "08:00") or "08:00"
                bh_end = (cfg_row["business_hours_end"] if cfg_row and "business_hours_end" in cfg_row.keys() else "18:00") or "18:00"
                bh_days = (cfg_row["business_days"] if cfg_row and "business_days" in cfg_row.keys() else "1,2,3,4,5") or "1,2,3,4,5"

                # Recalcula o vencimento (due_at) caso o SLA em horas tenha sido editado pelo Admin
                due_at = row["due_at"]
                if abs(new_sla_hours - float(row["sla_hours"])) > 0.001:
                    try:
                        created_dt = datetime.fromisoformat(row["created_at"])
                        due_at = calculate_business_due(created_dt, new_sla_hours, bh_start, bh_end, bh_days).isoformat()
                    except Exception:
                        pass

                new_status = body.get("status", row["status"])
                new_tech = body.get("technician", row["technician"])
                new_hours = float(body.get("hoursSpent", row["hours_spent"]))
                new_prob_found = (
                    body.get("problemFound").strip()
                    if "problemFound" in body and body.get("problemFound") is not None
                    else (row["problem_found"] if "problem_found" in row.keys() and row["problem_found"] else "")
                )
                new_serv_perf = (
                    body.get("servicePerformed").strip()
                    if "servicePerformed" in body and body.get("servicePerformed") is not None
                    else (row["service_performed"] if "service_performed" in row.keys() and row["service_performed"] else "")
                )

                # Controle de assigned_at (quando o chamado é direcionado para um técnico)
                curr_assigned_at = row["assigned_at"] if "assigned_at" in row.keys() else None
                if "assignedAt" in body:
                    assigned_at = body.get("assignedAt")
                elif new_tech != row["technician"] and (new_tech or "").lower().strip() not in ("", "aguardando direcionamento (admin)", "aguardando atribuição", "não atribuído"):
                    assigned_at = datetime.now(timezone.utc).isoformat()
                else:
                    assigned_at = curr_assigned_at

                # Controle de started_at (quando o técnico dá o aceite e inicia o atendimento)
                curr_started_at = row["started_at"] if "started_at" in row.keys() else None
                if "startedAt" in body:
                    started_at = body.get("startedAt")
                elif new_status == "Em Atendimento" and not curr_started_at:
                    started_at = datetime.now(timezone.utc).isoformat()
                elif new_status == "Aberto" and body.get("resetStartedAt"):
                    started_at = None
                else:
                    started_at = curr_started_at

                # Controle de first_responded_at (cumprimento do SLA de Primeira Resposta)
                curr_first_resp = row["first_responded_at"] if "first_responded_at" in row.keys() else None
                if "firstRespondedAt" in body:
                    first_responded_at = body.get("firstRespondedAt")
                elif (started_at or new_status == "Em Atendimento") and not curr_first_resp:
                    first_responded_at = started_at or datetime.now(timezone.utc).isoformat()
                else:
                    first_responded_at = curr_first_resp

                resolved_at = row["resolved_at"]
                if new_status == "Resolvido" and row["status"] != "Resolvido":
                    resolved_at = datetime.now(timezone.utc).isoformat()
                elif new_status != "Resolvido":
                    resolved_at = None

                cur.execute("""
                    UPDATE tickets SET
                        title = ?,
                        description = ?,
                        user_id = ?,
                        client_id = ?,
                        equipment_id = ?,
                        problem_type_id = ?,
                        sla_hours = ?,
                        priority = ?,
                        status = ?,
                        technician = ?,
                        hours_spent = ?,
                        problem_found = ?,
                        service_performed = ?,
                        assigned_at = ?,
                        started_at = ?,
                        first_responded_at = ?,
                        due_at = ?,
                        resolved_at = ?
                    WHERE id = ?;
                """, (
                    new_title,
                    new_desc,
                    new_user_id,
                    new_client_id,
                    new_equip_id,
                    new_prob_id,
                    new_sla_hours,
                    new_priority,
                    new_status,
                    new_tech,
                    new_hours,
                    new_prob_found,
                    new_serv_perf,
                    assigned_at,
                    started_at,
                    first_responded_at,
                    due_at,
                    resolved_at,
                    tid
                ))

                # Alimenta automaticamente o Banco de Soluções quando o chamado é finalizado com Problema Encontrado e/ou Serviço Realizado
                if new_status == "Resolvido" and (new_prob_found or new_serv_perf):
                    cur.execute("SELECT id, attachments_json FROM solutions WHERE ticket_id = ?;", (tid,))
                    existing_sol = cur.fetchone()
                    now_iso = resolved_at or datetime.now(timezone.utc).isoformat()
                    incoming_attachments = body.get("solutionAttachments") or []

                    if existing_sol:
                        current_atts = json.loads((existing_sol["attachments_json"] if "attachments_json" in existing_sol.keys() else "[]") or "[]")
                        if incoming_attachments:
                            existing_ids = {a.get("id") for a in current_atts if isinstance(a, dict)}
                            for att in incoming_attachments:
                                if isinstance(att, dict) and att.get("id") not in existing_ids:
                                    current_atts.append(att)
                        cur.execute("""
                            UPDATE solutions SET
                                problem_type_id = ?,
                                title = ?,
                                problem_found = ?,
                                service_performed = ?,
                                technician = ?,
                                hours_spent = ?,
                                attachments_json = ?,
                                created_at = ?
                            WHERE id = ?;
                        """, (
                            new_prob_id,
                            new_title,
                            new_prob_found or "Não especificado",
                            new_serv_perf or "Não especificado",
                            new_tech,
                            new_hours,
                            json.dumps(current_atts, ensure_ascii=False),
                            now_iso,
                            existing_sol["id"]
                        ))
                    else:
                        sol_id = "sol-" + str(int(time.time() * 1000))
                        cur.execute("""
                            INSERT INTO solutions (
                                id, ticket_id, problem_type_id, title, problem_found,
                                service_performed, technician, hours_spent, attachments_json, created_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
                        """, (
                            sol_id,
                            tid,
                            new_prob_id,
                            new_title,
                            new_prob_found or "Não especificado",
                            new_serv_perf or "Não especificado",
                            new_tech,
                            new_hours,
                            json.dumps(incoming_attachments, ensure_ascii=False),
                            now_iso
                        ))

                conn.commit()
                self._send_json({"ok": True, "state": fetch_full_state()})
                return

            # 6B. CADASTRAR / ATUALIZAR SOLUÇÃO NO BANCO DE SOLUÇÕES
            if parsed.path == "/api/solutions":
                sol_id = body.get("id") or ("sol-" + str(int(time.time() * 1000)))
                now_iso = datetime.now(timezone.utc).isoformat()
                attachments = body.get("attachments") if isinstance(body.get("attachments"), list) else []
                cur.execute("""
                    INSERT OR REPLACE INTO solutions (
                        id, ticket_id, problem_type_id, title, problem_found,
                        service_performed, technician, hours_spent, attachments_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
                """, (
                    sol_id,
                    (body.get("ticketId") or "").strip(),
                    (body.get("problemTypeId") or "").strip(),
                    (body.get("title") or "").strip(),
                    (body.get("problemFound") or "").strip(),
                    (body.get("servicePerformed") or "").strip(),
                    (body.get("technician") or "Equipe Técnica").strip(),
                    float(body.get("hoursSpent") or 0),
                    json.dumps(attachments, ensure_ascii=False),
                    now_iso
                ))
                conn.commit()
                self._send_json({"ok": True, "solutionId": sol_id, "state": fetch_full_state()})
                return

            # 6C. ANEXAR OU REMOVER ARQUIVO PDF EM UMA SOLUÇÃO EXISTENTE
            if parsed.path == "/api/solutions/attachments":
                sol_id = (body.get("solutionId") or "").strip()
                action = body.get("action") or "add"
                cur.execute("SELECT * FROM solutions WHERE id = ?;", (sol_id,))
                sol_row = cur.fetchone()

                # Caso a solução tenha sido gerada de um chamado antes da tabela solutions existir
                if not sol_row and sol_id.startswith("sol-auto-"):
                    ticket_id_ref = sol_id.replace("sol-auto-", "")
                    cur.execute("SELECT * FROM tickets WHERE id = ?;", (ticket_id_ref,))
                    t_row = cur.fetchone()
                    if t_row:
                        now_iso = t_row["resolved_at"] or t_row["created_at"]
                        cur.execute("""
                            INSERT INTO solutions (
                                id, ticket_id, problem_type_id, title, problem_found,
                                service_performed, technician, hours_spent, attachments_json, created_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?);
                        """, (
                            sol_id,
                            t_row["id"],
                            t_row["problem_type_id"] or "",
                            t_row["title"],
                            t_row["problem_found"] or "Não especificado",
                            t_row["service_performed"] or "Não especificado",
                            t_row["technician"] or "Equipe Técnica",
                            float(t_row["hours_spent"] or 0),
                            now_iso
                        ))
                        cur.execute("SELECT * FROM solutions WHERE id = ?;", (sol_id,))
                        sol_row = cur.fetchone()

                if not sol_row:
                    self._send_json({"ok": False, "error": "Solução não encontrada."}, 404)
                    return

                atts = json.loads((sol_row["attachments_json"] if "attachments_json" in sol_row.keys() else "[]") or "[]")
                if action == "add":
                    new_att = body.get("attachment")
                    if isinstance(new_att, dict) and new_att.get("dataUrl"):
                        atts.append(new_att)
                elif action == "remove":
                    att_id = body.get("attachmentId")
                    atts = [a for a in atts if a.get("id") != att_id]

                cur.execute(
                    "UPDATE solutions SET attachments_json = ? WHERE id = ?;",
                    (json.dumps(atts, ensure_ascii=False), sol_id)
                )
                conn.commit()
                self._send_json({"ok": True, "state": fetch_full_state()})
                return

            # 7. ADICIONAR NOTA / INTERAÇÃO NO CHAMADO (REGISTRA 1ª RESPOSTA SE FOR DA EQUIPE TÉCNICA)
            if parsed.path == "/api/tickets/note":
                tid = body["ticketId"]
                cur.execute("SELECT * FROM tickets WHERE id = ?;", (tid,))
                row = cur.fetchone()
                if not row:
                    self._send_json({"ok": False, "error": "Chamado não encontrado"}, 404)
                    return
                notes = json.loads(row["notes_json"] or "[]")
                now_iso = datetime.now(timezone.utc).isoformat()
                author_name = body.get("author", "Usuário")
                notes.append({
                    "id": "nt-" + str(int(time.time() * 1000)),
                    "author": author_name,
                    "text": body["text"].strip(),
                    "createdAt": now_iso
                })

                # Se a nota veio de um técnico/admin e o chamado ainda não tem 1ª resposta registrada:
                is_staff_note = bool(body.get("isStaff")) or "técnico" in author_name.lower() or "admin" in author_name.lower()
                curr_first_resp = row["first_responded_at"] if "first_responded_at" in row.keys() else None
                new_first_resp = curr_first_resp
                if is_staff_note and not curr_first_resp:
                    new_first_resp = now_iso

                cur.execute("""
                    UPDATE tickets SET
                        notes_json = ?,
                        first_responded_at = ?
                    WHERE id = ?;
                """, (json.dumps(notes, ensure_ascii=False), new_first_resp, tid))
                conn.commit()
                self._send_json({"ok": True, "state": fetch_full_state()})
                return

            # 8. ZERAR TODO O BANCO DE DADOS
            if parsed.path == "/api/reset":
                cur.execute("DELETE FROM solutions;")
                cur.execute("DELETE FROM tickets;")
                cur.execute("DELETE FROM equipment;")
                cur.execute("DELETE FROM problem_types;")
                cur.execute("DELETE FROM users;")
                cur.execute("DELETE FROM clients;")
                cur.execute("""
                    UPDATE contract SET
                        client_name = '',
                        cnpj = '',
                        contract_number = '',
                        monthly_hours_quota = 0,
                        sla_target_percent = 95,
                        manager_name = ''
                    WHERE id = 1;
                """)
                conn.commit()
                self._send_json({"ok": True, "state": fetch_full_state()})
                return

            self._send_json({"ok": False, "error": "Rota não encontrada"}, 404)
        except sqlite3.IntegrityError as e:
            self._send_json({"ok": False, "error": f"Registro duplicado ou inválido: {str(e)}"}, 400)
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 500)
        finally:
            conn.close()

    def do_DELETE(self):
        parsed = urlparse(self.path)
        parts = parsed.path.strip("/").split("/")
        # Ex: /api/clients/<id>, /api/users/<id>, /api/problems/<id>, /api/tickets/<id>, /api/solutions/<id>, /api/equipment/<id>
        if len(parts) == 3 and parts[0] == "api":
            resource, item_id = parts[1], parts[2]
            conn = get_conn()
            cur = conn.cursor()
            if resource == "clients":
                cur.execute("DELETE FROM clients WHERE id = ?;", (item_id,))
            elif resource == "users":
                cur.execute("DELETE FROM users WHERE id = ?;", (item_id,))
            elif resource == "equipment":
                cur.execute("DELETE FROM equipment WHERE id = ?;", (item_id,))
            elif resource == "problems":
                cur.execute("DELETE FROM problem_types WHERE id = ?;", (item_id,))
            elif resource == "tickets":
                cur.execute("DELETE FROM tickets WHERE id = ?;", (item_id,))
            elif resource == "solutions":
                cur.execute("DELETE FROM solutions WHERE id = ?;", (item_id,))
            conn.commit()
            conn.close()
            self._send_json({"ok": True, "state": fetch_full_state()})
            return
        self._send_json({"ok": False, "error": "Rota DELETE inválida"}, 404)


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), AppRequestHandler)
    print(f"Servidor SQLite (Multi-Thread) iniciado em http://{HOST}:{PORT}")
    print(f"Banco de dados salvo em: {DB_PATH}")
    server.serve_forever()
