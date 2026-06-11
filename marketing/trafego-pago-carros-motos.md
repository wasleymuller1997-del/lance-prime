# Plano de Tráfego Pago — LancePrime (Carros e Motos)

> Guia prático pra começar a vender carros e motos com anúncios pagos no
> **Instagram + Facebook (Meta Ads)**. Feito pra operação enxuta, do zero.

---

## 0. Antes de gastar 1 real (pré-requisitos)

| Item | Por quê | Status |
|------|---------|--------|
| Conta no **Gerenciador de Negócios** (business.facebook.com) | Centraliza páginas, pixel e anúncios | ☐ |
| **Página do Instagram + Facebook** da LancePrime conectadas | Anúncio precisa rodar por uma página | ☐ |
| **Pixel da Meta** instalado no `lanceprimecards.com` | Mede quem visitou/deu lance/mandou WhatsApp | ☐ |
| **WhatsApp Business** (com catálogo, se possível) | Maioria das vendas de veículo fecha no zap | ☐ |
| Fotos boas dos veículos (já vêm da importação Dealers) | Criativo é 80% do resultado | ☐ |

> **Dica técnica:** o pixel pode ir no `<head>` do `frontend/index.html`. Eventos úteis
> pra rastrear: `ViewContent` (viu um veículo), `Lead` (clicou no WhatsApp),
> `InitiateCheckout` (deu lance/fez oferta). Me peça que eu instalo isso no site.

---

## 1. Objetivo da campanha (escolha 1 para começar)

Para venda de veículo, **não venda pelo clique** — gere **conversa**. Comece com:

- **Objetivo: Vendas → conversões em "Mensagens" (WhatsApp/Direct)**
  Melhor custo-benefício pra começar: pessoa clica no anúncio e já cai no zap.

Depois que tiver pixel maduro (50+ leads), teste:
- **Tráfego para o site** (página do veículo) → remarketing de quem viu.

---

## 2. Estrutura de campanha recomendada (simples)

```
CAMPANHA: LancePrime | Vendas - Mensagens
│
├── CONJUNTO 1 — Frio | Interesse Carros (raio 30-50km da sua cidade)
│     Público: 25-50 anos, interesse em "carros usados", "OLX", "Webmotors"
│
├── CONJUNTO 2 — Frio | Interesse Motos
│     Público: 20-45 anos, interesse em "motocicletas", "Honda CG", etc.
│
└── CONJUNTO 3 — Remarketing (ligar quando tiver tráfego)
      Público: visitou o site nos últimos 30 dias + engajou no Insta
```

**Orçamento inicial sugerido:** R$ 20–40/dia por conjunto frio (R$ 40–80/dia total).
Rode 5–7 dias **sem mexer** antes de julgar. Algoritmo precisa aprender.

---

## 3. Públicos (audiências)

**Geográfico (o mais importante pra veículo):** raio em volta de onde o cliente
retira o veículo. Carro vende bem até ~50–100km; moto ~30–50km.

| Público | Idade | Interesses / sinais |
|---------|-------|---------------------|
| Compradores de carro | 25–55 | carros usados, seminovos, Webmotors, OLX Autos, financiamento de veículos |
| Compradores de moto | 20–45 | motocicletas, CNH A, marcas (Honda, Yamaha), delivery/app |
| Caçadores de oferta | 25–50 | leilão de veículos, carros de leilão, oportunidade |
| **Remarketing** | todos | visitou site, viu veículo, mandou msg, engajou no perfil |
| **Lookalike (depois)** | — | semelhante a quem já comprou/mandou msg |

---

## 4. Criativos (o que mais importa)

### Formatos que funcionam pra veículo
1. **Reels/vídeo curto (9–20s)** mostrando o carro/moto por fora e dentro + preço/condição.
2. **Carrossel** com 4–6 fotos do veículo (frente, lateral, painel, motor, detalhe).
3. **Foto única** com selo de preço/parcela grande e legível.

### Regras de ouro do criativo
- **Mostre o preço ou "a partir de R$ X/mês".** Esconder preço derruba conversão.
- Primeiros 3 segundos = o veículo + um número (preço/km/ano).
- Legenda do veículo na imagem (ano, km, parcela) — muita gente vê sem som.
- 1 veículo por anúncio nos testes. Use 3–5 anúncios diferentes por conjunto.

---

## 5. Copies prontas (é só trocar os dados)

**Anúncio — Carro (mensagem direta)**
```
🚗 [MODELO ANO] na LancePrime
✅ [KM] km | Documentação em dia | Procedência garantida
💰 R$ [VALOR] ou a partir de R$ [PARCELA]/mês

Sem enrolação: veículo selecionado, processo transparente e você dá seu lance.
👉 Chama no WhatsApp agora e garanta antes que saia. (estoque limitado)
```

**Anúncio — Moto**
```
🏍️ [MODELO ANO] — pronta pra rodar
✅ [KM] km | Revisada | Aceita troca
💰 R$ [VALOR] | Entrada a partir de R$ [ENTRADA]

Ideal pra trabalho ou dia a dia. Poucas unidades.
👉 Manda "QUERO" no WhatsApp que te passo tudo.
```

**Anúncio — Leilão / oportunidade (ângulo de urgência)**
```
🔥 Oportunidade LancePrime
[MODELO ANO] saindo por menos que a tabela.
Dê seu lance em lanceprimecards.com ou fale com a gente.
⏳ Lances abertos por tempo limitado.
👉 Toque em "Saiba mais".
```

> **Ângulos de teste** (rode em paralelo pra ver o que converte):
> preço baixo · parcela acessível · procedência/segurança · urgência (leilão) · "aceita troca".

---

## 6. Métricas — o que olhar (e o que ignorar)

| Métrica | Bom sinal | Significa |
|---------|-----------|-----------|
| **CPM** (custo/mil impressões) | varia por região | quanto custa aparecer |
| **CTR** (taxa de clique) | > 1% | criativo está atraindo |
| **Custo por conversa iniciada** | quanto menor, melhor | $ pra gerar 1 lead no zap |
| **Custo por venda** | sua meta real | só isso paga as contas |

**Ignore no começo:** curtidas e seguidores. O que importa é **conversa → visita → venda**.

> Defina sua conta: ex. "se 1 carro me dá R$ 2.000 de lucro e fecho 1 a cada
> 10 conversas, posso pagar até ~R$ 150–200 por conversa." Isso vira seu teto de CPL.

---

## 7. Rotina semanal (operação enxuta)

- **Diário (5 min):** responder rápido todo lead do WhatsApp/Direct (velocidade vende).
- **A cada 3 dias:** ver custo por conversa de cada anúncio.
- **Semanal:** desligar os 2 piores criativos, subir 2 novos. Subir orçamento (+20%) só no que vende.
- **Quinzenal:** ligar/atualizar remarketing e lookalike.

---

## 8. Plano de 30 dias

| Semana | Foco |
|--------|------|
| 1 | Instalar pixel, criar BM/página/WhatsApp, subir 1ª campanha (carro + moto), R$40/dia |
| 2 | Deixar aprender, responder leads, anotar custo por conversa |
| 3 | Cortar criativos ruins, dobrar nos bons, ligar remarketing |
| 4 | Criar lookalike de quem mandou msg, escalar orçamento no que dá venda |

---

### Quer que eu coloque a mão na massa?
Posso, aqui no projeto:
- **Instalar o pixel da Meta** e os eventos no `index.html` / páginas de veículo.
- Adicionar **botão flutuante de WhatsApp** com link `wa.me` pré-preenchido.
- Gerar **gerador automático de copy + criativo** a partir de um veículo do estoque
  (puxando dados que já vêm da importação da Dealers).
- Criar uma aba **"Marketing"** no admin com esses prompts e gerador de anúncios.

É só dizer qual desses você quer primeiro.
