# 🛠️ ServiceDesk Pro — Sistema de Chamados Técnicos, SLA & Banco de Soluções

![Versão](https://img.shields.io/badge/versão-v1.6.0-4f46e5)
![Backend](https://img.shields.io/badge/Python_3-SQLite_WAL-10b981)
![Licença](https://img.shields.io/badge/uso-Corporativo_/_Contratos_Fixos-f59e0b)

Sistema web completo de **Gestão de Chamados Técnicos (Help Desk / Service Desk)**, **Controle de SLA em Tempo Real**, **Gestão de Múltiplos Clientes de Contrato Fixo** e **Banco de Soluções com Documentação em PDF**.

---

## ✨ Principais Funcionalidades

### 1. Gestão de Múltiplos Clientes de Contrato Fixo
- Cadastro ilimitado de empresas clientes com CNPJ, número do contrato, gestor responsável, franquia mensal de horas e meta contratual de SLA (%).
- Acompanhamento automático do consumo da franquia mensal de horas por cliente.
- Vínculo direto de usuários solicitantes ao respectivo contrato fixo.

### 2. Hierarquia de Acesso em 3 Níveis (`ADMIN`, `TECH`, `USER`)
- **Administrador (`ADMIN`)**:
  - Recebe todos os chamados abertos na **Central de Triagem** para direcionar a um técnico ou assumir o atendimento diretamente (**"Atender Eu Mesmo"**).
  - Edição completa de qualquer chamado (solicitante, contrato, tipo de problema, prazo de SLA, título e descrição).
  - Gerenciamento completo de usuários: cadastro, edição, vínculo de contrato, bloqueio de acesso, desbloqueio/redefinição de senha e exclusão.
  - **Relatório Gerencial Completo** (visão consolidada ou filtrada por cliente de contrato).
- **Técnico de Suporte (`TECH`)**:
  - Visualiza e atende os chamados direcionados a ele pelo Administrador (ou liberados na Fila Técnica Geral).
  - Aponta horas trabalhadas, registra o **Problema Encontrado** e o **Serviço Realizado**, finaliza chamados e alimenta/consulta o **Banco de Soluções**.
  - Acessa seu **Relatório de Desempenho Técnico & Cumprimento de SLA**.
- **Usuário Comum / Solicitante (`USER`)**:
  - Abre chamados técnicos com cálculo automático do prazo de SLA conforme o catálogo contratual.
  - Acompanha em tempo real o cronômetro de SLA, interações e o laudo técnico dos seus próprios chamados.
  - Acessa seu **Relatório Individual de Chamados**.

### 3. Segurança & Personalização Visual
- **Troca de Senha Obrigatória no 1º Acesso**: Todo novo usuário (ou usuário cuja senha foi redefinida/desbloqueada pelo Administrador) é direcionado automaticamente para cadastrar uma senha pessoal no primeiro login.
- **Identidade Visual Customizável**: Upload da logo da sua empresa de TI/Suporte exibida na tela de login e no menu lateral.
- **Perfil do Usuário**: Todos os perfis podem alterar sua foto de perfil, trocar a senha e escolher entre **7 temas de cores** (*Índigo, Azul Oceano, Esmeralda, Roxo Real, Rubi, Laranja Âmbar e Grafite*).

### 4. Finalização Técnica & Banco de Soluções com PDF
- **Laudo de Finalização no Atendimento**: Campos dedicados para **Problema Encontrado (Diagnóstico Técnico)** e **Serviço Realizado (Solução Aplicada)**, além do botão **"Finalizar Chamado & Salvar Solução"**.
- **Banco de Soluções Automático e Manual**:
  - Alimentado automaticamente a cada chamado finalizado (vinculado ao protocolo `CH-...`, categoria do problema, técnico e horas).
  - Permite consulta rápida e preenchimento automático em 1 clique dentro de novos atendimentos recorrentes.
  - **Documentação de Apoio em PDF**: Upload, listagem, download e visualizador integrado de arquivos `.pdf` (manuais, diagramas, topologias e procedimentos operacionais) em cada solução.

---

## 🗂️ Estrutura de Arquivos

```text
├── index.html              # Interface completa (Login, Chamados, Relatórios, Banco de Soluções, Usuários, SLA, Contratos e Perfil)
├── styles.css              # Estilos customizados, temas de cores (CSS Variables) e layout de impressão
├── db.js                   # Camada de sincronização de dados (API REST + fallback local) e gerador de schema SQL
├── app.js                  # Lógica de negócio, cálculo de SLA em tempo real, hierarquia, Banco de Soluções e leitor de PDF
├── server.py               # Servidor HTTP Multi-Thread em Python 3 + Banco de Dados Relacional SQLite (database.db em modo WAL)
├── database.db             # Banco de dados SQLite relacional (contract, clients, users, problem_types, tickets, solutions)
├── install-vps.sh          # Script de instalação automática para VPS Linux (Ubuntu/Debian) com systemd
├── configurar-dominio.sh   # Script automático para configurar domínio próprio + certificado HTTPS (Caddy) na VPS
├── Dockerfile              # Imagem Docker oficial para deploy em containers
├── docker-compose.yml      # Orquestração Docker Compose com volume persistente para o SQLite
├── render.yaml             # Blueprint para deploy na nuvem Render.com
├── railway.json            # Configuração para deploy na nuvem Railway.app
└── VERSION                 # Arquivo de controle de versão SemVer
```

---

## 🚀 Como Executar

### 1. Rodar Localmente (Mac / Linux / Windows)
```bash
python3 server.py
```
Acesse no navegador: **`http://localhost:8080`**
- **Login Administrador Inicial**: Usuário `admin` | Senha `admin123`

### 2. Instalar em uma VPS Linux (Ubuntu / Debian)
Conecte na sua VPS via SSH e execute:
```bash
git clone https://github.com/MALC89/chamado-tecnico.git /opt/chamado-tecnico && cd /opt/chamado-tecnico && sudo bash install-vps.sh
```

### 3. Atualizar a VPS com Nova Versão do GitHub
Sempre que houver nova atualização no GitHub, execute na VPS (mantém o banco `database.db` intacto):
```bash
cd /opt/chamado-tecnico && git pull origin main && sudo systemctl restart chamado-tecnico
```

### 4. Configurar Domínio Próprio + HTTPS Grátis na VPS
Após apontar um registro DNS Tipo `A` para o IP da sua VPS:
```bash
cd /opt/chamado-tecnico && git pull origin main && sudo bash configurar-dominio.sh chamados.mascti.com.br
```

---

## 📦 Histórico de Versionamento (Changelog)

| Versão | Data | Descrição das Entregas |
| :--- | :--- | :--- |
| **`v1.6.0`** | Out/2026 | **Sincronização Automática em Tempo Real (Live Sync)**: Atualização automática sem recarregar a página (`F5`) quando o Admin direciona chamados para o Técnico, quando novos chamados são abertos e quando o Técnico finaliza/atualiza o chamado (sincronizando na hora a tela do Admin e do Solicitante). |
| **`v1.5.0`** | Out/2026 | **Documentação de Apoio em PDF no Banco de Soluções**: Upload de múltiplos arquivos PDF no Banco de Soluções e na finalização do chamado, leitor de PDF integrado em modal, download e versionamento completo do repositório. |
| **`v1.4.0`** | Out/2026 | **Finalização Técnica & Banco de Soluções**: Campos obrigatórios de *Problema Encontrado* e *Serviço Realizado* ao encerrar chamados, botão *Finalizar Chamado & Salvar Solução*, aba *Banco de Soluções* e reaproveitamento de soluções em 1 clique. |
| **`v1.3.0`** | Out/2026 | **Multi-Contratos & Senha Obrigatória no 1º Acesso**: Cadastro de múltiplos clientes de contrato fixo, vínculo de contrato no cadastro de usuários, troca de senha obrigatória no primeiro acesso e botão de desbloquear/resetar senha pelo Admin. |
| **`v1.2.0`** | Out/2026 | **Hierarquia em 3 Níveis, Triagem do Admin & Temas**: Perfis `ADMIN`, `TECH` e `USER` com relatórios dedicados, central de direcionamento do Admin, edição completa de chamados, foto de perfil e 7 temas de cores. |
| **`v1.1.0`** | Out/2026 | **Identidade Visual & Tela de Login Corporativa**: Tela de login limpa sem exposição de senhas e suporte a upload de logotipo da empresa. |
| **`v1.0.0`** | Out/2026 | **Lançamento Inicial**: Abertura de chamados técnicos, catálogo de problemas com SLA automático e persistência relacional em SQLite (`database.db`). |
