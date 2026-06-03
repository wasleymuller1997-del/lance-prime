# MotoPrime — Estoque de motos (site público + painel)

Projeto **independente** (zero ligação com LancePrime/Dealers) para uma agência de
motos. Inspirado no sistema de estoque que o cliente curtiu, com duas faces:

- **Site público** (`index.html`) — vitrine premium das motos, com **preço final**.
  Cliente navega, filtra e chama no WhatsApp. Não mostra compra, custos nem lucro.
- **Painel admin** (`admin.html`) — onde o dono cadastra as motos, **lança os custos**
  e acompanha o **lucro** pela fórmula **Venda − Compra − Custos = Lucro**, com
  Central de Custos e Simulador igual ao modelo do Wasley.

## Como rodar (agora — standalone)

É 100% estático. Basta abrir os arquivos num servidor estático qualquer:

```bash
cd motoprime
python3 -m http.server 8080
# Site público:  http://localhost:8080/index.html
# Painel admin:  http://localhost:8080/admin.html
```

> Os dados ficam no **navegador** (localStorage). Cadastrou no painel → aparece no
> site público na mesma máquina. Já vem com motos de exemplo; o botão
> **"Dados de exemplo"** no painel restaura tudo.

## Trocar a marca do cliente (1 lugar só)

Edite **`assets/config.js`**: nome, tagline, WhatsApp, telefone, e-mail, cidade,
Instagram e as cores do gradiente. Site e painel se atualizam sozinhos.

## Estrutura

```
motoprime/
├─ index.html            # site público
├─ admin.html            # painel admin
├─ README.md
└─ assets/
   ├─ config.js          # MARCA + cores + helpers (edite aqui)
   ├─ store.js           # camada de dados (localStorage) ← encaixe do backend
   ├─ styles.css         # tema dark premium compartilhado
   ├─ public.js          # lógica do site público
   └─ admin.js           # lógica do painel
```

## Caminho pro full-stack (depois)

Toda a persistência passa por **`assets/store.js`** (`window.MotoStore`). É o único
arquivo que muda quando for pra produção: troca-se o localStorage por chamadas
`fetch` a uma API. O resto (`public.js`, `admin.js`, HTML) **não muda**, porque só
conversa com o `MotoStore`. Sugestão de backend, reaproveitando a arquitetura atual:

- **Node + Express + Postgres** (mesma stack do projeto de referência).
- Tabela `motos` (marca, modelo, ano, km, cc, cor, compra, venda, referência,
  status, fotos, destaque, observações) + tabela `moto_costs` (categoria,
  descrição, valor, data) — espelhando o modelo de `store.js`.
- Endpoints: `GET /motos` (público filtra `status != vendida`), `POST/PUT/DELETE
  /motos`, `POST/DELETE /motos/:id/costs`, login do dono pro painel.

Quando tiver o repositório próprio criado, esta pasta já é autossuficiente: dá pra
mover o conteúdo pra raiz do novo repo e seguir daqui.
