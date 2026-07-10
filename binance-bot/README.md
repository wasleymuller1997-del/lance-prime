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
   - **EMA 9 / EMA 21** — cruzamento define a direção (compra ou venda)
   - **RSI 14** — filtro para evitar entradas esticadas
   - **ATR 14** — mede a volatilidade para posicionar o stop
3. Se houver sinal, calcula o tamanho da posição para arriscar **1% da banca**
   (se o stop for atingido, perde-se ~1%) e abre a operação com:
   - **Stop loss** a 1,5 × ATR da entrada
   - **Take profit** a 2× a distância do stop (risco:retorno 1:2)
4. Gerencia a posição até fechar no stop, no alvo ou em cruzamento contrário

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
se o robô for desligado.

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
| `interval` | 15m | Tempo gráfico dos candles |
| `pollSeconds` | 30 | Intervalo entre análises |
| `leverage` | 5 | Alavancagem usada nas posições |
| `riskPerTradePct` | 1 | % da banca arriscada por operação |
| `maxOpenPositions` | 2 | Posições simultâneas no máximo |
| `maxDailyLossPct` | 5 | Trava: perdeu isso no dia, para de entrar |
| `cooldownMinutes` | 60 | Espera mínima entre operações no mesmo par |
| `closeOnOppositeSignal` | true | Fecha a posição se aparecer cruzamento contrário |
| `paperStartBalance` | 10000 | Banca inicial do modo paper |
| `takerFeePct` | 0.05 | Taxa por ordem (entra no cálculo do resultado) |
| `strategy.emaFast/emaSlow` | 9 / 21 | Períodos das médias |
| `strategy.rsiPeriod` | 14 | Período do RSI |
| `strategy.rsiLongMin/Max` | 50 / 70 | Faixa de RSI aceita para compra |
| `strategy.rsiShortMin/Max` | 30 / 50 | Faixa de RSI aceita para venda |
| `strategy.atrPeriod` | 14 | Período do ATR |
| `strategy.atrStopMult` | 1.5 | Distância do stop em múltiplos de ATR |
| `strategy.riskReward` | 2 | Alvo = 2× a distância do stop |

## Estrutura do projeto

```
binance-bot/
├── index.js              # inicia o robô
├── backtest.js           # testa a estratégia em dados históricos
├── config.json           # todos os parâmetros
├── .env.example          # modelo das chaves (copie para .env)
└── src/
    ├── bot.js            # loop principal (análise → risco → execução)
    ├── strategy.js       # sinais: EMA cross + RSI + ATR
    ├── indicators.js     # EMA, RSI e ATR (suavização de Wilder)
    ├── risk.js           # tamanho de posição, stop/alvo, arredondamentos
    ├── binanceRest.js    # cliente da API de futuros (testnet)
    ├── paperBroker.js    # corretora simulada (modo paper)
    ├── testnetBroker.js  # corretora real na conta demo (modo testnet)
    ├── config.js         # carrega config.json + .env
    └── logger.js         # log em console + logs/bot.log
```

## Próximos passos (ideias)

- WebSocket em vez de polling (reação instantânea)
- Mais estratégias plugáveis (rompimento, reversão à média, grid)
- Trailing stop
- Painel web para acompanhar as operações
- Alertas no WhatsApp/Telegram a cada operação
