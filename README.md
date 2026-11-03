# 🛠️ ServiceDesk Pro — Sistema de Chamados Técnicos, SLA & Banco de Soluções

![Versão](https://img.shields.io/badge/versão-v1.8.1-4f46e5)
![Backend](https://img.shields.io/badge/Python_3-SQLite_WAL-10b981)
![Licença](https://img.shields.io/badge/uso-Corporativo_/_Contratos_Fixos-f59e0b)

Sistema web completo de **Gestão de Chamados Técnicos (Help Desk / Service Desk)**, **Inventário de Equipamentos & Ativos de TI com Deduplicação**, **Controle de SLA em Horário de Expediente (1ª Resposta vs Resolução)**, **Correlação Automática de Soluções**, **Gestão de Múltiplos Clientes de Contrato Fixo**, **Aceite e Histórico de Início de Atendimento** e **Banco de Soluções com Documentação em PDF**.

---

## ✨ Principais Funcionalidades

### 1. Inventário de Equipamentos & Gestão de Ativos de TI
- **Catálogo Completo de Ativos**: Cadastro e gestão de Desktops, Notebooks, Servidores, Impressoras, Equipamentos de Rede (Switches/Roteadores), Nobreaks e Monitores.
- **Deduplicação Automática por Número de Série / Service Tag**: Impede cadastros duplicados. Se um número de série já existente for inserido em um novo chamado ou no inventário, o sistema reutiliza e atualiza o mesmo ativo automaticamente.
- **Histórico Completo por Equipamento**: Linha do tempo de todas as manutenções e chamados técnicos já realizados para cada máquina, facilitando diagnósticos recorrentes e auditorias de parque tecnológico.
- **Filtros e Indicadores KPIs**: Visão rápida de ativos totais, estações de trabalho, infraestrutura de rede/servidores e equipamentos com chamados abertos em manutenção.

### 2. Associação de Equipamentos ao Chamado & Correlação Automática de Soluções
- **Seleção ou Cadastro Rápido**: No formulário de abertura de chamado, o solicitante ou técnico pode escolher um equipamento existente ou cadastrar um novo informando apenas Tipo, Nome/Modelo e Número de Série.
- **Fim da Busca Manual no Chamado**: Remoção da caixa de busca manual dentro do modal de atendimento.
- **Correlação Inteligente Automática**: Ao abrir os detalhes do chamado, o sistema correlaciona e exibe automaticamente:
  - Soluções anteriores cadastradas no Banco de Soluções para a mesma categoria de problema.
  - Histórico de manutenções já executadas na mesma máquina/equipamento.
  - Botão de aplicação em 1 clique para preencher o laudo técnico com base no histórico comprovado.

### 3. Horário de Atendimento / Expediente Comercial & SLA Diferenciado
- **Configuração de Expediente**: Definição flexível do horário comercial (ex: 08:00 às 18:00) e dias úteis de atendimento (Segunda a Sexta-feira).
- **SLA Não Corre Fora do Expediente**: O relógio de SLA pausa automaticamente fora do horário comercial (noites, madrugadas e finais de semana), garantindo que os prazos reflitam estritamente a janela contratual acordada com o cliente.
- **SLA Duplo (1ª Resposta vs Resolução Final)**:
  - **SLA de Primeira Resposta**: Prazo útil até o técnico aceitar/iniciar o chamado ou registrar a primeira nota técnica de posicionamento ao solicitante.
  - **SLA de Resolução**: Prazo útil total para encerramento do chamado com o laudo do serviço realizado.

### 4. Gestão de Múltiplos Clientes de Contrato Fixo
- Cadastro ilimitado de empresas clientes com CNPJ, número do contrato, gestor responsável, franquia mensal de horas e meta contratual de SLA (%).
- Acompanhamento automático do consumo da franquia mensal de horas por cliente.
- Vínculo direto de usuários solicitantes ao respectivo contrato fixo.

### 5. Hierarquia de Acesso em 3 Níveis (`ADMIN`, `TECH`, `USER`)
- **Administrador (`ADMIN`)**:
  - Recebe todos os chamados abertos na **Central de Triagem** para direcionar a um técnico ou assumir o atendimento diretamente (**"Atender Eu Mesmo"**).
  - Ao direcionar o chamado para um técnico, o status **permanece como `Aberto`** e registra o momento exato em que o técnico recebeu no sistema (`assignedAt`).
  - Edição completa de qualquer chamado (solicitante, contrato, tipo de problema, prazos de SLA, título e descrição).
  - Gerenciamento completo de usuários e inventário de equipamentos.
  - **Relatório Gerencial Completo** (visão consolidada ou filtrada por cliente de contrato).
- **Técnico de Suporte (`TECH`)**:
  - Visualiza os chamados direcionados a ele com status `Aberto • ⏳ Aguardando Aceite`.
  - **Aceite & Início de Atendimento**: Botão em destaque **`▶️ Aceitar Chamado & Iniciar Atendimento`** (na lista e no modal) que registra a data/hora oficial de início (`startedAt`), muda o status para `Em Atendimento` e gera o registro histórico.
  - Aponta horas trabalhadas, registra o **Problema Encontrado** e o **Serviço Realizado**, finaliza chamados e alimenta/consulta o **Banco de Soluções**.
  - Acessa seu **Relatório de Desempenho Técnico & Cumprimento de SLA**.
- **Usuário Comum / Solicitante (`USER`)**:
  - Abre chamados técnicos com cálculo automático do prazo de SLA útil conforme o catálogo contratual.
  - Acompanha em tempo real a linha do tempo de 4 etapas: Abertura (`createdAt`), Recebido (`assignedAt`), Início do Atendimento (`startedAt`) e Resolução (`resolvedAt`).
  - Acessa seu **Relatório Individual de Chamados**.

### 6. Segurança & Personalização Visual
- **Tela de Login Segura**: Remoção do reset público de senhas na tela de login; o desbloqueio/redefinição de senha é exclusivo do perfil Administrador dentro do painel seguro.
- **Troca de Senha Obrigatória no 1º Acesso**: Todo novo usuário (ou usuário cuja senha foi redefinida/desbloqueada pelo Administrador) é direcionado automaticamente para cadastrar uma senha pessoal no primeiro login.
- **Identidade Visual Customizável**: Upload da logo da sua empresa de TI/Suporte exibida na tela de login e no menu lateral.
- **Perfil do Usuário**: Todos os perfis podem alterar sua foto de perfil, trocar a senha e escolher entre **7 temas de cores** (*Índigo, Azul Oceano, Esmeralda, Roxo Real, Rubi, Laranja Âmbar e Grafite*).

### 7. Finalização Técnica & Banco de Soluções com PDF
- **Laudo de Finalização no Atendimento**: Campos dedicados para **Problema Encontrado (Diagnóstico Técnico)** e **Serviço Realizado (Solução Aplicada)**, além do botão **"Finalizar Chamado & Salvar Solução"**.
- **Banco de Soluções Automático e Manual**:
  - Alimentado automaticamente a cada chamado finalizado (vinculado ao protocolo `CH-...`, categoria do problema, técnico e horas).
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
| **`v1.8.1`** | Nov/2026 | **Correção de Carregamento do Inventário, Painel Interativo de Expediente & SLA Noturno**: Correção crítica de sintaxe que impedia abertura do modal de equipamentos e navegação; painel interativo de horários com 4 presets (Comercial, Flex, Estendido, Plantão 24/7); seletores toggle de dias da semana (Seg a Dom); simulador interativo de abertura fora do expediente garantindo que chamados abertos à noite não estourem o SLA; indicador em tempo real de status do suporte no topo; atalho para o inventário dentro do novo chamado. |
| **`v1.8.0`** | Nov/2026 | **Inventário de Equipamentos, Correlação Automática de Soluções, Expediente Comercial & SLA Duplo**: Gestão de ativos com deduplicação por número de série/Service Tag; associação de equipamentos no chamado; correlação automática de soluções e manutenções anteriores no atendimento; configuração de horário de expediente com pausa do SLA fora do horário comercial e finais de semana; SLA de 1ª Resposta vs Resolução. |
| **`v1.7.0`** | Out/2026 | **Aceite do Técnico, Início de Atendimento & Segurança de Login**: Chamados direcionados mantêm status `Aberto` até aceite do técnico; novo botão e painel `Iniciar Atendimento`; registro dos timestamps `assignedAt` e `startedAt` com linha do tempo de 4 etapas; remoção do reset público de senhas na tela de login (apenas Administrador no painel). |
| **`v1.6.0`** | Out/2026 | **Sincronização Automática em Tempo Real (Live Sync)**: Atualização automática sem recarregar a página (`F5`) quando o Admin direciona chamados para o Técnico, quando novos chamados são abertos e quando o Técnico finaliza/atualiza o chamado (sincronizando na hora a tela do Admin e do Solicitante). |
| **`v1.5.0`** | Out/2026 | **Documentação de Apoio em PDF no Banco de Soluções**: Upload de múltiplos arquivos PDF no Banco de Soluções e na finalização do chamado, leitor de PDF integrado em modal, download e versionamento completo do repositório. |
| **`v1.4.0`** | Out/2026 | **Finalização Técnica & Banco de Soluções**: Campos obrigatórios de *Problema Encontrado* e *Serviço Realizado* ao encerrar chamados, botão *Finalizar Chamado & Salvar Solução*, aba *Banco de Soluções* e reaproveitamento de soluções em 1 clique. |
| **`v1.3.0`** | Out/2026 | **Multi-Contratos & Senha Obrigatória no 1º Acesso**: Cadastro de múltiplos clientes de contrato fixo, vínculo de contrato no cadastro de usuários, troca de senha obrigatória no primeiro acesso e botão de desbloquear/resetar senha pelo Admin. |
| **`v1.2.0`** | Out/2026 | **Hierarquia em 3 Níveis, Triagem do Admin & Temas**: Perfis `ADMIN`, `TECH` e `USER` com relatórios dedicados, central de direcionamento do Admin, edição completa de chamados, foto de perfil e 7 temas de cores. |
| **`v1.1.0`** | Out/2026 | **Identidade Visual & Tela de Login Corporativa**: Tela de login limpa sem exposição de senhas e suporte a upload de logotipo da empresa. |
| **`v1.0.0`** | Out/2026 | **Lançamento Inicial**: Abertura de chamados técnicos, catálogo de problemas com SLA automático e persistência relacional em SQLite (`database.db`). |
