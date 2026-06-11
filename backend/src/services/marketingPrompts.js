/**
 * Templates dos prompts de marketing usados na aba Marketing do admin.
 *
 * Cada template tem placeholders no formato {chave}. A funcao fillPrompt(template, vars)
 * faz a substituicao. Os prompts foram adaptados dos 8 templates de crescimento
 * de Instagram (originalmente genericos com [NICHO]/[PUBLICO]/[OFERTA]) pra ficar
 * especifico do mercado de seminovos e do publico-alvo da Multimarcas Premium.
 *
 * NOTA: voz e mercado configuraveis pela aba "Marketing" no admin (futuro).
 * Por enquanto fixos no contexto da loja (Betim/MG, semovios).
 */

const BRAND = 'Multimarcas Premium';
const LOCATION = 'Betim/MG e regiao metropolitana de BH';
const DEFAULT_AUDIENCE = 'pessoas de 25-55 anos da Grande BH que querem trocar de carro, com poder de compra medio/alto, valorizam confianca e querem ver tudo (laudo, historico) antes de fechar';

const SYSTEM_BASE = `Voce e um estrategista de marketing digital especialista em vendas de veiculos seminovos no Brasil. Trabalha pra ${BRAND}, uma loja de veiculos selecionados em ${LOCATION}.

Diferenciais reais da loja que voce DEVE usar nos conteudos quando fizer sentido:
- Vistoria cautelar completa em todo veiculo
- Garantia de procedencia (documentacao limpa)
- Financiamento facilitado em ate 60x
- Aceitamos o carro do cliente como entrada
- Atendimento personalizado, sem pressao

REGRAS DE TOM:
- Linguagem direta, brasileira, sem regionalismos do sul
- Foco no DESEJO e na DOR do cliente final (nao no produto)
- ZERO jargao tecnico desnecessario ("aquisicao", "viabilidade")
- ZERO promessa proibida pela Lei do Consumidor ("garantido", "imperdivel")
- Evitar palavras-gatilho do algoritmo do Meta que reduzem alcance ("incrivel", "voce nao vai acreditar")

REGRAS DE FORMATO:
- Sempre responda em portugues brasileiro
- Quando pedir "lista", use numeracao 1. 2. 3. (nao bullets)
- Quando pedir copy curta (caption/anuncio), respeite limites de plataforma
- Nao use emojis em excesso — maximo 1-2 por bloco`;


// 1. PLANO DE CRESCIMENTO NO INSTAGRAM (perfil)
const PROMPT_PLANO_CRESCIMENTO = `Crie uma estrategia COMPLETA de crescimento no Instagram pro perfil @{handle} da {brand}, com foco em {audience}.

Saida estruturada em 5 blocos:

1. PILARES DE CONTEUDO (4 pilares)
   - Para cada: nome, objetivo, % do mix, exemplos de tema

2. ANALISE DA AUDIENCIA (com base no nicho)
   - 3 dores principais
   - 3 desejos principais
   - 3 objecoes mais comuns na hora de comprar
   - Onde elas estao no Instagram (que tipo de perfil seguem)

3. POSICIONAMENTO
   - Frase de posicionamento em 1 linha (bio do perfil)
   - 3 lacunas no nicho que a loja pode explorar
   - O que a loja NAO deve postar (pra nao virar commodity)

4. ALAVANCAS DE CRESCIMENTO (priorizadas)
   - 5 acoes concretas, ordenadas por impacto/esforco
   - Pra cada uma: o que faz, quanto tempo leva, resultado esperado

5. METRICAS-CHAVE pra acompanhar nas primeiras 4 semanas

Seja especifico, com exemplos do mercado de seminovos. Nada generico.`;


// 2. MOTOR DE PESQUISA DE AUDIENCIA
const PROMPT_PESQUISA_AUDIENCIA = `Analise este publico-alvo: {audience}

Identifique e estruture:

1. MAIORES FRUSTRACOES (5 itens, ordenados por intensidade)
2. OBJETIVOS (5 itens, o que essa pessoa quer alcancar)
3. MEDOS na hora de comprar um veiculo seminovo (5 itens)
4. OBJECOES OCULTAS (5 itens — coisas que a pessoa pensa mas nao fala)
5. MOTIVACOES DE COMPRA (5 itens, por que ela ACABA comprando)
6. RESULTADOS DESEJADOS (3 transformacoes que ela espera pos-compra)

Em seguida, gere:
- 10 TEMAS DE CONTEUDO atrelados a esses pontos
- 10 ANGULOS DE POST (forma de abordar) que atraem atencao, constroem confianca e criam demanda

Cada item deve ter no maximo 1 linha. Seja especifico do nicho de seminovos.`;


// 3. GERADOR DE CONTEUDO VIRAL
const PROMPT_VIRAL = `Gere 50 ideias de conteudo para o Instagram da {brand} (nicho: veiculos seminovos), com foco em {audience}.

Concentre-se em angulos que geram engajamento real:
- ERROS comuns que as pessoas cometem comprando carro usado
- MITOS do mercado de seminovos que merecem ser quebrados
- OPINIOES IMPOPULARES (que o lojista honesto pode defender)
- LICOES de quem ja comprou errado
- FRAMEWORKS simples (3 passos pra avaliar um carro, etc.)
- OPORTUNIDADES OCULTAS (modelos subvalorizados, melhor mes pra comprar, etc.)
- TENDENCIAS atuais do mercado
- DORES especificas (financiamento, entrada, troca, documentacao)

REGRAS:
- 50 ideias numeradas (1 a 50)
- Cada uma em 1 linha, especifica e ja com um GANCHO embutido
- Misture formatos: Reel, carrossel, story, post estatico
- Foque em ALCANCE e COMPARTILHAMENTO (gera valor / quebra crenca / da insight)
- Use casos reais do mercado brasileiro de seminovos

Formato:
1. [TIPO] Titulo/gancho da ideia`;


// 4. CRIADOR DE GANCHO E REELS
const PROMPT_REEL = `Transforme esta ideia: "{ideia}"
em um roteiro de Reel de ALTA RETENCAO para o Instagram da {brand}.

Estrutura obrigatoria:

1. GANCHO (primeiros 2 segundos)
   - 3 opcoes de gancho diferentes
   - Cada uma com 1 linha falada + 1 linha de cena visual sugerida

2. ROTEIRO COMPLETO (do gancho escolhido — usar o mais forte)
   - Bloco a bloco, max 5 cenas
   - Pra cada: o que falar (1-2 frases) + o que mostrar (cena visual)
   - Duracao total alvo: 25-40 segundos

3. CONCLUSAO MEMORAVEL
   - Frase final que da reviravolta OU cria curiosidade pro proximo
   - CTA (chamada pra acao) — qual? por que?

4. LEGENDA do post (caption pro Instagram)
   - Max 220 caracteres
   - Sem hashtag aqui (vem separado)

5. HASHTAGS sugeridas (8-12, misturando volume alto/medio/baixo, locais incluidos)

6. AUDIO / TREND sugerido
   - Tipo de audio que combina (trending acelerado, voz unica, audio do proprio video)

Lembrete: escrita conversacional, otimizada para tempo de exibicao.`;


// 5. OTIMIZADOR DE CONTEUDO
const PROMPT_OTIMIZAR = `Analise este conteudo: "{conteudo}"

Identifique problemas em ordem de impacto:

1. GANCHOS FRACOS — quais sao? por que sao fracos?
2. FRASES GENERICAS — onde aparecem? qual e a versao impactante?
3. POSICIONAMENTO RUIM — algo que distancia o leitor da loja?
4. ENCHIMENTO — o que pode ser cortado sem perda?
5. SINAIS DE REDUCAO DE ENGAJAMENTO — palavras-gatilho do Meta, tom errado, etc.

Em seguida, REESCREVA o conteudo melhorando:
- Clareza (qualquer um deveria entender)
- Impacto emocional (gerar reacao)
- Retencao (manter o leitor ate o fim)
- Valor percebido (a pessoa sente que aprendeu/recebeu algo)

Importante: mantenha o SIGNIFICADO ORIGINAL intacto, so afie a entrega.

Formato da resposta:
- Diagnostico (5 pontos acima, curto)
- Versao reescrita (texto final, pronto pra postar)`;


// 6. GERADOR DE CONTEUDO DE VENDAS
const PROMPT_VENDAS = `Gere 20 ideias de conteudo para o Instagram da {brand} desenvolvidas para ATRAIR LEADS / GERAR VENDAS para a oferta: "{oferta}"

Aborde objecoes, frustracoes, objetivos, preocupacoes de compra e transformacoes desejadas da audiencia ({audience}).

Cada ideia deve:
- Ser EDUCATIVA E VALIOSA (cliente aprende algo)
- Posicionar a oferta como solucao natural (sem empurrar)
- Ter um gancho de abertura embutido
- Indicar o FORMATO ideal (Reel, carrossel, story sequence, post unico)

Formato:
1. [FORMATO] Titulo/gancho
   - Angulo: (de que dor/desejo ela parte)
   - Conclusao: (como conecta com a oferta)

Misture: bottom-of-funnel (decisao), middle (consideracao) e top (descoberta). Indique de qual etapa cada ideia e.`;


// 7. MOTOR DE REAPROVEITAMENTO
const PROMPT_REAPROVEITAR = `Pegue este conteudo original: "{conteudo}"
e transforme em 5 formatos diferentes pro Instagram da {brand}. A mensagem central deve ficar consistente; muda a forma.

Saida estruturada:

1. REEL (roteiro completo: gancho + 3-4 cenas + CTA)
2. CARROSSEL (8 slides; pra cada slide: titulo curto + 1-2 linhas de texto + descricao visual)
3. LEGENDA DE POST ESTATICO (caption pronta, sem hashtags)
4. CONTEUDO PARA STORIES (sequencia de 6-8 stories, cada um com texto + sugestao de sticker/elemento interativo)
5. THREADS / X (versao em formato de thread, 6-8 posts curtos)

Cada formato deve respeitar as particularidades de consumo daquele lugar (ex: Reel = ritmo rapido, carrossel = swipe-friendly, stories = enquete/interativo).`;


// 8. SISTEMA DE 60 DIAS
const PROMPT_60_DIAS = `Crie um SISTEMA COMPLETO de crescimento e monetizacao no Instagram de 60 DIAS para a {brand} (nicho: veiculos seminovos), com foco em {audience}.

Estrutura obrigatoria:

1. METAS DOS 60 DIAS (3 metas mensuraveis: alcance/seguidores/leads/agendamentos)

2. PILARES DE CONTEUDO (3-4 pilares com % de mix)

3. PLANEJAMENTO SEMANA A SEMANA (8 semanas)
   - Cada semana tem: tema da semana + 5 posts/Reels (com titulo curto e formato)
   - Crescente: comeca com base, vai aumentando autoridade ate vendas diretas

4. TATICAS DE CRESCIMENTO DE AUDIENCIA (5 taticas)
   - Pra cada: o que faz, frequencia semanal, tempo estimado

5. ESTRUTURA DE POSTAGEM (frequencia semanal recomendada)
   - Reels: X por semana
   - Carrosseis: X
   - Stories: X dias por semana
   - Post estatico: X

6. FLUXOS DE ENGAJAMENTO (3 fluxos automatizaveis: como responder DM, como abordar quem comentou, como acompanhar lead frio)

7. METODOS DE GERACAO DE LEADS (3 sistemas: bio link, DM bot, stories CTA)

8. SISTEMA DE REAPROVEITAMENTO (regra: cada post novo gera quantos derivados em que prazo)

9. REVISOES DE PERFORMANCE (KPIs semanais + acoes baseadas nos numeros)

REGRAS:
- Tudo realista pra criador SOLO (lojista mexendo no proprio celular)
- Simples e escalavel
- Use NUMEROS concretos (nao "muitos posts", mas "4 Reels por semana")`;


const PROMPTS = {
  plano_crescimento: { system: SYSTEM_BASE, user: PROMPT_PLANO_CRESCIMENTO, label: 'Plano de crescimento (perfil)' },
  pesquisa_audiencia: { system: SYSTEM_BASE, user: PROMPT_PESQUISA_AUDIENCIA, label: 'Pesquisa de audiencia' },
  conteudo_viral: { system: SYSTEM_BASE, user: PROMPT_VIRAL, label: '50 ideias de conteudo viral' },
  reel_roteiro: { system: SYSTEM_BASE, user: PROMPT_REEL, label: 'Roteiro de Reel (a partir de uma ideia)' },
  otimizar_conteudo: { system: SYSTEM_BASE, user: PROMPT_OTIMIZAR, label: 'Otimizar conteudo existente' },
  conteudo_vendas: { system: SYSTEM_BASE, user: PROMPT_VENDAS, label: '20 ideias de venda (por oferta)' },
  reaproveitar: { system: SYSTEM_BASE, user: PROMPT_REAPROVEITAR, label: 'Reaproveitar conteudo (5 formatos)' },
  sistema_60_dias: { system: SYSTEM_BASE, user: PROMPT_60_DIAS, label: 'Sistema completo de 60 dias' },
};

function fillPrompt(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, function(_, key) {
    return vars[key] != null ? String(vars[key]) : '';
  });
}

// Defaults reaproveitaveis (usados quando o admin nao preencher)
const DEFAULTS = {
  brand: BRAND,
  handle: 'multimarcaspremium',
  audience: DEFAULT_AUDIENCE,
  location: LOCATION,
};

module.exports = { PROMPTS, DEFAULTS, fillPrompt };
