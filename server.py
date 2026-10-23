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

    # Migração automática de colunas de marca e tema caso o banco já exista
    existing_cols = [row["name"] for row in cur.execute("PRAGMA table_info(contract);").fetchall()]
    for col_name, default_val in [
        ("company_name", "'ServiceDesk Pro'"),
        ("company_logo", "''"),
        ("login_subtitle", "'Portal de Chamados Técnicos & Controle de SLA'"),
        ("support_contact", "''"),
        ("admin_avatar", "''"),
        ("theme_color", "'indigo'")
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
                admin_avatar, theme_color
            ) VALUES (
                1, '', '', '', 'Contrato Fixo Mensal', 0, 95, '', 'Ativo',
                'admin', 'admin123', 'ServiceDesk Pro', '', 'Portal de Chamados Técnicos & Controle de SLA', '',
                '', 'indigo'
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
            priority TEXT NOT NULL DEFAULT 'Média',
            description TEXT DEFAULT ''
        );
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS tickets (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            user_id TEXT NOT NULL,
            client_id TEXT DEFAULT '',
            problem_type_id TEXT NOT NULL,
            sla_hours REAL NOT NULL,
            priority TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'Aberto',
            technician TEXT DEFAULT 'Aguardando Direcionamento (Admin)',
            hours_spent REAL DEFAULT 0,
            problem_found TEXT DEFAULT '',
            service_performed TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            due_at TEXT NOT NULL,
            resolved_at TEXT,
            notes_json TEXT DEFAULT '[]'
        );
    """)

    ticket_cols = [row["name"] for row in cur.execute("PRAGMA table_info(tickets);").fetchall()]
    if "client_id" not in ticket_cols:
        cur.execute("ALTER TABLE tickets ADD COLUMN client_id TEXT DEFAULT '';")
    if "problem_found" not in ticket_cols:
        cur.execute("ALTER TABLE tickets ADD COLUMN problem_found TEXT DEFAULT '';")
    if "service_performed" not in ticket_cols:
        cur.execute("ALTER TABLE tickets ADD COLUMN service_performed TEXT DEFAULT '';")

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
        "themeColor": (c_row["theme_color"] if "theme_color" in c_row.keys() else "indigo") or "indigo"
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
            "problemTypeId": r["problem_type_id"],
            "slaHours": r["sla_hours"],
            "priority": r["priority"],
            "status": r["status"],
            "technician": r["technician"],
            "hoursSpent": r["hours_spent"],
            "problemFound": (r["problem_found"] if "problem_found" in r.keys() else "") or "",
            "servicePerformed": (r["service_performed"] if "service_performed" in r.keys() else "") or "",
            "createdAt": r["created_at"],
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
        "problemTypes": problem_types,
        "tickets": tickets,
        "solutions": solutions
    }


class AppRequestHandler(SimpleHTTPRequestHandler):
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

            # 2. ATUALIZAR CONTRATO PADRÃO E IDENTIDADE VISUAL (LOGO DA EMPRESA)
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
                        theme_color = ?
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
                    body.get("themeColor", curr["theme_color"] or "indigo")
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

            # 4. CADASTRAR TIPO DE PROBLEMA & SLA
            if parsed.path == "/api/problems":
                pid = "prb-" + str(int(time.time() * 1000))
                cur.execute("""
                    INSERT INTO problem_types (id, name, category, default_sla_hours, priority, description)
                    VALUES (?, ?, ?, ?, ?, ?);
                """, (
                    pid,
                    body["name"].strip(),
                    body["category"].strip(),
                    float(body.get("defaultSlaHours") or 4),
                    body.get("priority", "Média"),
                    (body.get("description") or "").strip()
                ))
                conn.commit()
                self._send_json({"ok": True, "problemId": pid, "state": fetch_full_state()})
                return

            # 5. ABRIR NOVO CHAMADO (VAI PARA O ADMINISTRADOR DIRECIONAR OU ATENDER)
            if parsed.path == "/api/tickets":
                cur.execute("SELECT COUNT(*) as cnt FROM tickets;")
                next_num = 1001 + cur.fetchone()["cnt"]
                tid = f"CH-{next_num}"
                now = datetime.now(timezone.utc)
                sla_hours = float(body.get("slaHours") or 4)
                due = now + timedelta(hours=sla_hours)

                # Se clientId não veio no body, herda do usuário solicitante
                client_id = (body.get("clientId") or "").strip()
                if not client_id and body.get("userId"):
                    cur.execute("SELECT client_id FROM users WHERE id = ?;", (body["userId"],))
                    ur = cur.fetchone()
                    if ur and ur["client_id"]:
                        client_id = ur["client_id"]

                cur.execute("""
                    INSERT INTO tickets (
                        id, title, description, user_id, client_id, problem_type_id,
                        sla_hours, priority, status, technician, hours_spent,
                        created_at, due_at, resolved_at, notes_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Aberto', ?, 0, ?, ?, NULL, '[]');
                """, (
                    tid,
                    body["title"].strip(),
                    body["description"].strip(),
                    body["userId"],
                    client_id,
                    body["problemTypeId"],
                    sla_hours,
                    body.get("priority", "Média"),
                    (body.get("technician") or "Aguardando Direcionamento (Admin)").strip(),
                    now.isoformat(),
                    due.isoformat()
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
                new_prob_id = body.get("problemTypeId") or row["problem_type_id"]
                new_priority = body.get("priority") or row["priority"]
                new_sla_hours = float(body.get("slaHours") if "slaHours" in body and body["slaHours"] is not None else row["sla_hours"])

                # Recalcula o vencimento (due_at) caso o SLA em horas tenha sido editado pelo Admin
                due_at = row["due_at"]
                if abs(new_sla_hours - float(row["sla_hours"])) > 0.001:
                    try:
                        created_dt = datetime.fromisoformat(row["created_at"])
                        due_at = (created_dt + timedelta(hours=new_sla_hours)).isoformat()
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
                        problem_type_id = ?,
                        sla_hours = ?,
                        priority = ?,
                        status = ?,
                        technician = ?,
                        hours_spent = ?,
                        problem_found = ?,
                        service_performed = ?,
                        due_at = ?,
                        resolved_at = ?
                    WHERE id = ?;
                """, (
                    new_title,
                    new_desc,
                    new_user_id,
                    new_client_id,
                    new_prob_id,
                    new_sla_hours,
                    new_priority,
                    new_status,
                    new_tech,
                    new_hours,
                    new_prob_found,
                    new_serv_perf,
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

            # 7. ADICIONAR NOTA / INTERAÇÃO NO CHAMADO
            if parsed.path == "/api/tickets/note":
                tid = body["ticketId"]
                cur.execute("SELECT notes_json FROM tickets WHERE id = ?;", (tid,))
                row = cur.fetchone()
                if not row:
                    self._send_json({"ok": False, "error": "Chamado não encontrado"}, 404)
                    return
                notes = json.loads(row["notes_json"] or "[]")
                notes.append({
                    "id": "nt-" + str(int(time.time() * 1000)),
                    "author": body.get("author", "Usuário"),
                    "text": body["text"].strip(),
                    "createdAt": datetime.now(timezone.utc).isoformat()
                })
                cur.execute("UPDATE tickets SET notes_json = ? WHERE id = ?;", (json.dumps(notes, ensure_ascii=False), tid))
                conn.commit()
                self._send_json({"ok": True, "state": fetch_full_state()})
                return

            # 8. ZERAR TODO O BANCO DE DADOS
            if parsed.path == "/api/reset":
                cur.execute("DELETE FROM solutions;")
                cur.execute("DELETE FROM tickets;")
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
        # Ex: /api/clients/<id>, /api/users/<id>, /api/problems/<id>, /api/tickets/<id>, /api/solutions/<id>
        if len(parts) == 3 and parts[0] == "api":
            resource, item_id = parts[1], parts[2]
            conn = get_conn()
            cur = conn.cursor()
            if resource == "clients":
                cur.execute("DELETE FROM clients WHERE id = ?;", (item_id,))
            elif resource == "users":
                cur.execute("DELETE FROM users WHERE id = ?;", (item_id,))
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
