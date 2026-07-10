# Robô Binance Futures — conta demo (testnet)

Robô que opera no **mercado futuro da Binance**: fica analisando o mercado em tempo
real, detecta oportunidades de entrada e executa as operações com stop loss e take
profit automáticos, tudo na **conta demo (testnet)** — dinheiro de mentira, risco zero.

> ⚠️ **Aviso**: robô nenhum garante lucro. Use a testnet até ter confiança nos
> resultados, e mesmo depois disso opere com dinheiro real só o que puder perder.
> Este projeto é apenas para estudo na conta demo.

## Como funciona

A cada 30 segundos (configurável) o robô:

1. Busca os candles mais recentes de cada símbolo (BTCUSDT, ETHUSDT, ...)
2. Calcula os indicadores no último candle **fechado**:
   - **EMA 8 / EMA 34** — cruzamento define a direção (compra ou venda)
   - **RSI 14** — filtro para evitar entradas esticadas
   - **ATR 14** — mede a volatilidade para posicionar o stop
3. Se houver sinal, calcula o tamanho da posição para arriscar **1% da banca**
   (taxas já incluídas — se o stop bater, perde-se ~1%) e abre a operação com:
   - **Stop loss** a 1,5 × ATR da entrada
   - **Take profit** a 1,5× a distância do stop
4. Gerencia a posição até fechar no stop, no alvo ou em cruzamento contrário

Os valores padrão vieram da **varredura de parâmetros** (`node sweep.js`), que
testou 2.592 combinações exigindo lucro em dois períodos e nos dois símbolos —
no gráfico de 1h. Rode a varredura de tempos em tempos para recalibrar.

Proteções embutidas: máximo de posições simultâneas, intervalo mínimo entre
operações no mesmo símbolo e **trava de perda diária** (parou de cair 5% no dia,
para de abrir entradas até o dia seguinte).

## Modos de operação

| Modo | O que faz | Precisa de chave? |
|------|-----------|-------------------|
| `paper` (padrão) | Simula a conta localmente com preços reais da testnet | Não |
| `testnet` | Envia ordens reais para a sua conta demo da Binance | Sim (chave da testnet) |

No modo `testnet`, o stop e o alvo ficam registrados **na corretora**
(`STOP_MARKET` / `TAKE_PROFIT_MARKET`), então a posição continua protegida mesmo
se o robô for desligado. A política é rígida: se o registro do stop falhar, o
robô fecha a posição na hora — e se nem isso der certo, ele continua rastreando
e tentando proteger a cada ciclo, avisando no log.

Regras da simulação (modos paper e backtest):

- No candle de entrada, só o preço **depois** da entrada conta para stop/alvo
- Se o candle tocou stop e alvo, assume-se que o **stop** veio primeiro (pessimista)
- Se o preço **abriu** além do stop (gap), a saída é no preço do gap, não no stop
- O tamanho da posição já desconta as taxas de entrada e saída do risco por trade
- Cooldowns, sinais consumidos e a trava diária **sobrevivem a reinícios**
  (ficam salvos em `data/`)

## Requisitos

- Node.js 18 ou superior (sem nenhuma dependência externa — `npm install` não é necessário)

## Começando (modo paper — 1 minuto)

```bash
cd binance-bot
node index.js
```

Pronto. O robô cria uma conta simulada com 10.000 USDT e começa a analisar o
mercado. Tudo fica registrado em:

- `logs/bot.log` — cada análise, sinal e decisão
- `data/state.json` — saldo e posições da conta simulada
- `data/trades.csv` — histórico de operações (abre no Excel)

## Testando a estratégia no passado (backtest)

Antes de deixar o robô rodando, veja como a estratégia teria se saído:

```bash
node backtest.js                          # 1º símbolo do config, últimos 30 dias
node backtest.js --symbol ETHUSDT --days 60
```

O relatório mostra número de operações, taxa de acerto, fator de lucro,
resultado líquido e rebaixamento máximo. Use-o para ajustar os parâmetros do
`config.json` (períodos das EMAs, faixas de RSI, risco:retorno etc.).

## Painel no celular (PWA)

Junto com o robô sobe um painel web em `http://localhost:8484` com:

- Saldo e resultado do dia em tempo real
- Posições abertas com **lucro/prejuízo ao vivo**, stop, alvo e tempo de operação
- Botão **"Encerrar agora a mercado"** — viu que já deu um bom lucro? Garante na hora
- Botão **Pausar/Retomar** novas entradas (posições abertas continuam protegidas)
- Histórico das últimas operações

**Para usar no celular** (mesma rede Wi-Fi do computador que roda o robô):

1. Descubra o IP do computador (`ipconfig` no Windows / `ip addr` no Linux)
2. No celular, abra `http://IP-DO-PC:8484`
3. No menu do navegador, toque em **"Adicionar à tela inicial"** — vira um app

Se outras pessoas usam a sua rede, defina um token no `.env`
(`DASHBOARD_TOKEN=algumasenha`) — o painel pede o token no primeiro acesso.
A porta muda em `DASHBOARD_PORT` ou em `dashboardPort` no `config.json`.

## Painel no site (lanceprimecars.com/robocrypto)

Além do painel local, o robô pode espelhar tudo no **seu site** — aí você
acompanha e comanda de **qualquer lugar** (4G, trabalho, viagem), com o mesmo
login do admin do LancePrime.

Como funciona: o robô manda o status pro site a cada ~7s e traz de volta os
comandos que você tocou no painel (encerrar, pausar, retomar). Só tráfego de
saída — não precisa abrir porta nem configurar nada na sua internet.

Para ativar:

1. **No servidor do site**: defina a variável de ambiente `ROBO_KEY` com uma
   senha longa qualquer (ex.: `ROBO_KEY=troque-por-uma-chave-bem-grande`)
2. **No `.env` do robô**:
   ```
   RELAY_URL=https://lanceprimecars.com
   RELAY_KEY=mesmo-valor-da-ROBO_KEY
   ```
3. Rode o robô e abra `lanceprimecars.com/robocrypto` no celular
   (faça login no `/admin` primeiro; dá pra "Adicionar à tela inicial")

O painel mostra se o robô está **online** (bolinha verde) e avisa quando ele
está desligado. Comandos chegam ao robô em até ~7 segundos.

## Conectando na conta demo da Binance (modo testnet)

1. Acesse **https://testnet.binancefuture.com** e faça login (pode criar conta
   só com e-mail — é separada da Binance normal)
2. No rodapé da tela, aba **API Key**, copie a *API Key* e a *Secret Key*
3. Na pasta do robô:
   ```bash
   cp .env.example .env
   # edite o .env e preencha:
   #   BINANCE_API_KEY=...
   #   BINANCE_API_SECRET=...
   #   BOT_MODE=testnet
   node index.js
   ```

A conta demo já vem com saldo fictício em USDT. As operações do robô aparecem
na própria tela da testnet, como numa conta real.

## Configuração (`config.json`)

| Campo | Padrão | Significado |
|-------|--------|-------------|
| `symbols` | BTCUSDT, ETHUSDT | Pares que o robô acompanha |
| `interval` | 1h | Tempo gráfico dos candles |
| `pollSeconds` | 30 | Intervalo entre análises |
| `leverage` | 5 | Alavancagem usada nas posições |
| `riskPerTradePct` | 1 | % da banca arriscada por operação |
| `maxOpenPositions` | 2 | Posições simultâneas no máximo |
| `maxDailyLossPct` | 5 | Trava: perdeu isso no dia, para de entrar |
| `cooldownMinutes` | 60 | Espera mínima entre operações no mesmo par |
| `closeOnOppositeSignal` | true | Fecha a posição se aparecer cruzamento contrário |
| `paperStartBalance` | 10000 | Banca inicial do modo paper |
| `takerFeePct` | 0.05 | Taxa por ordem (entra no cálculo do resultado) |
| `strategy.emaFast/emaSlow` | 8 / 34 | Períodos das médias |
| `strategy.rsiPeriod` | 14 | Período do RSI |
| `strategy.rsiLongMin/Max` | 50 / 70 | Faixa de RSI aceita para compra |
| `strategy.rsiShortMin/Max` | 30 / 50 | Faixa de RSI aceita para venda |
| `strategy.atrPeriod` | 14 | Período do ATR |
| `strategy.atrStopMult` | 1.5 | Distância do stop em múltiplos de ATR |
| `strategy.riskReward` | 1.5 | Alvo = 1,5× a distância do stop |
| `strategy.maxCandlesInTrade` | 0 | Time-stop: fecha após N candles (0 = desligado) |

## Estrutura do projeto

```
binance-bot/
├── index.js              # inicia o robô + painel
├── backtest.js           # testa a estratégia em dados históricos
├── sweep.js              # varredura de parâmetros (milhares de combinações)
├── config.json           # todos os parâmetros
├── .env.example          # modelo das chaves (copie para .env)
├── web/                  # painel PWA (celular)
└── src/
    ├── bot.js            # loop principal (análise → risco → execução)
    ├── strategy.js       # sinais: EMA cross + RSI + ATR
    ├── indicators.js     # EMA, RSI e ATR (suavização de Wilder)
    ├── risk.js           # tamanho de posição, stop/alvo, arredondamentos
    ├── backtestEngine.js # motor de simulação (backtest e sweep)
    ├── binanceRest.js    # cliente da API de futuros (testnet)
    ├── paperBroker.js    # corretora simulada (modo paper)
    ├── testnetBroker.js  # corretora real na conta demo (modo testnet)
    ├── server.js         # servidor do painel (API + PWA)
    ├── config.js         # carrega config.json + .env
    └── logger.js         # log em console + logs/bot.log
```

## Próximos passos (ideias)

- WebSocket em vez de polling (reação instantânea)
- Mais estratégias plugáveis (rompimento, reversão à média, grid)
- Trailing stop
- Alertas no WhatsApp/Telegram a cada operação
- Acesso ao painel fora de casa (túnel tipo Tailscale/Cloudflare)
