# LancePrime

## O que é
LancePrime é a plataforma do usuário (Wasley Müller — `wasleymuller1997@gmail.com`).
É um site/marketplace de leilões/vendas de veículos com duas faces:

- **Público**: `lanceprimecars.com` — onde os clientes navegam veículos, dão lances e ofertas.
- **Admin**: `lanceprimecars.com/admin` — painel interno para gerenciar estoque, veículos, ofertas, usuários, financeiro e configurações.

Sempre que o usuário falar em "LancePrime", "a plataforma", "meu site", "admin", "dashboard"
ou "estoque", está se referindo a este projeto.

## Stack
- **Frontend**: HTML/CSS/JS puro (sem framework), em `frontend/`
  - `index.html` — site público
  - `admin.html` — painel admin (single-file, ~1000 linhas, com CSS e JS inline)
  - `css/style.css`, `js/api.js`, `js/app.js`, `js/auth.js`
- **Backend**: Node.js em `backend/src/`
- **Integração**: Dealers Club (importação de veículos via `scrape-dealers.js`)

## Identidade visual atual (admin)
- Tema dark: fundo `#0b0d17`, cards `#12152a`
- Gradiente roxo→ciano: `#6c5ce7` → `#00cec9`
- Fontes: Plus Jakarta Sans (corpo) + Space Grotesk (títulos/números)
- Ícones: Font Awesome 6.5

## Seções do admin
Dashboard · Meu Estoque · Veículos · Ofertas · Usuários · Financeiro · Configurações

## Branch de trabalho
Atualmente: `claude/project-windows-mobile-sync-c2Cru`

## Observações importantes
- O admin foi recentemente otimizado para mobile (grid 2x3 nos cards de estoque)
- Importação de veículos da Dealers já funciona (`importFromDealers()`)
- Há sistema de custos por veículo e simulador de lucro
