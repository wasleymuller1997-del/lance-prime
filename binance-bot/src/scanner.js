import { analyze } from './strategy.js';
import { INTERVALS } from './config.js';

// Scanner de mercado sob demanda (botão "Analisar mercado" do painel):
// varre as moedas abaixo em 15m e 1h com a MESMA estratégia dos robôs,
// ranqueia o que tem sinal agora ou está prestes a cruzar, e devolve um
// plano de entrada pronto (lado, entrada, stop, alvo e tamanho por risco).
// É informativo — os robôs continuam operando apenas o que está configurado.

export const SCAN_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT',
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'NEARUSDT', 'SUIUSDT',
  'LTCUSDT', 'WIFUSDT', '1000PEPEUSDT', 'OPUSDT',
];
const SCAN_INTERVALS = ['15m', '1h'];
const QUASE_LIMIAR = 0.08; // % de distância entre as EMAs pra considerar "quase cruzando"

export async function runScan({ client, config }) {
  const params = config.strategy;
  const takerFee = config.takerFeePct / 100;
  const makerFee = (config.makerFeePct ?? 0.02) / 100;
  const feePerLeg = config.entryMode === 'maker' ? (makerFee + takerFee) / 2 : takerFee;
  const oportunidades = [];
  let analisados = 0;

  for (const symbol of SCAN_SYMBOLS) {
    for (const interval of SCAN_INTERVALS) {
      try {
        const candles = await client.klines(symbol, interval, { limit: 250 });
        if (candles.length < 60) continue;
        analisados += 1;
        const forming = candles[candles.length - 1];
        const closed = candles.slice(0, -1);
        const res = analyze(closed, params);
        const s = res.snapshot;
        if (!s) continue;

        const price = forming.close;
        const atrPct = (s.atr / price) * 100;
        const distPct = s.emaFast != null ? ((s.emaFast - s.emaSlow) / price) * 100 : null;
        const idx24 = candles.length - 1 - Math.round(86_400_000 / INTERVALS[interval]);
        const chg24 = idx24 >= 0 ? ((price - candles[idx24].close) / candles[idx24].close) * 100 : null;

        let status = null;
        let side = null;
        let score = 0;
        if (res.signal) {
          status = 'sinal';
          side = res.signal;
          score = 100 + atrPct * 10;
        } else if (distPct != null && Math.abs(distPct) < QUASE_LIMIAR) {
          // médias coladas: um cruzamento pode sair nos próximos candles
          status = 'quase';
          side = distPct <= 0 ? 'long' : 'short';
          score = 50 + (QUASE_LIMIAR - Math.abs(distPct)) * 300 + atrPct * 5;
          res.reason = `médias praticamente coladas (${Math.abs(distPct).toFixed(3)}%) — um cruzamento de ${side === 'long' ? 'ALTA' : 'BAIXA'} pode sair nos próximos candles de ${interval}; fique de olho`;
        } else {
          continue; // sem setup, não polui a lista
        }

        const stopDistance = res.stopDistance ?? s.atr * params.atrStopMult;
        const sl = side === 'long' ? price - stopDistance : price + stopDistance;
        const tp = side === 'long' ? price + stopDistance * params.riskReward : price - stopDistance * params.riskReward;
        const custoPorUnidade = stopDistance + feePerLeg * 2 * price;
        const qtyNormal = 100 / custoPorUnidade; // risco de 1% numa banca de 10k
        const qtyTurbo = 300 / custoPorUnidade; // risco de 3% (perfil turbo)

        oportunidades.push({
          symbol,
          interval,
          status,
          side,
          score,
          price,
          rsi: s.rsi,
          atrPct,
          distPct,
          chg24,
          reason: res.reason,
          plano: {
            entrada: price,
            stop: sl,
            alvo: tp,
            qtyNormal,
            qtyTurbo,
            riscoNormal: 100,
            riscoTurbo: 300,
            ganhoSeAlvoNormal: 100 * params.riskReward,
            ganhoSeAlvoTurbo: 300 * params.riskReward,
          },
        });
      } catch {
        /* moeda/tempo indisponível: segue o baile */
      }
    }
  }

  oportunidades.sort((a, b) => b.score - a.score);
  return {
    at: Date.now(),
    moedas: SCAN_SYMBOLS.length,
    intervalos: SCAN_INTERVALS,
    analisados,
    oportunidades: oportunidades.slice(0, 6),
    aviso: 'Sugestões informativas com a mesma estratégia dos robôs — quantidades para banca de 10.000 USDT.',
  };
}
