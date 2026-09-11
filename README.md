# /dsh-fuse

Política de custo multi-agente para o DeepSeek Harness: o plugin mede cada
chamada do agente, **trava antes** de estourar o budget (fuse local, <100ms,
offline) e sincroniza com o painel SaaS — cujo 429 é o portão secundário. Só
métricas sobem: tokens, custo, modelo — o conteúdo das sessões **nunca sai da
máquina**.

Painel central: **https://dsh.openplan.cc** — gastos por organização, projeto
e pessoa, budgets que o plugin aplica localmente, e o histórico de cortes.

## Instalar

O pacote declara `dsh.bundle`, que é o que faz `dsh plugin add` ativar a
camada. Sem essa declaração o pnpm instalaria uma biblioteca inerte.

```bash
# npm — a forma canônica de instalação (publicado, v0.1.0)
dsh plugin --profile <perfil> add @openplan/dsh-fuse

# tarball (sem depender de registry)
pnpm pack                       # gera openplan-dsh-fuse-<versão>.tgz
dsh plugin --profile <perfil> add ./openplan-dsh-fuse-0.1.0.tgz

# direto do git (exige allowlist de build do pnpm >= 10 — veja a doc do harness)
dsh plugin --profile <perfil> add github:<org>/<repo>#<sha>
```

Fonte: **https://github.com/openplancc/dsh-fuse** (espelho gerado a cada
release — cada tag `v<versão>` corresponde a um commit deste monorepo).

O plugin usa `@libsql/client` como store local — zero build nativa,
distribuível sem compilação (Node ≥ 20).

Verifique a camada sem bootar:

```bash
dsh --profile <perfil> --dump-config   # mostra '# == @openplan/dsh-fuse'
```

## Configurar

O bundle traz defaults seguros (modo local-only, store ancorado no harness
home, sync de 60s). Para sobrescrever, edite o `cordis.patch.yml` **do seu
profile** — a camada do usuário, aplicada depois de todas as camadas de bundle.
A sobrescrita é uma **linha direta com o mesmo `id`** (não um segundo `insert:`,
que duplicaria o id e faria o loader falhar com `duplicate loader entry id`):

```yaml
# ~/.dsh/profiles/<perfil>/cordis.patch.yml
- id: fuse
  name: '@openplan/dsh-fuse'
  config:
    project: meu-projeto
    dev: eu@empresa.com
    # Segredo nunca em texto puro no YAML — a tag !!js resolve no load.
    orgKey: !!js process.env.DSH_ORG_KEY
    baseUrl: https://dsh-api.openplan.cc
    # Orçamento local (o fuse corta offline antes de gastar):
    budgets:
      - limitUsd: 50
        window: month
      - limitUsd: 5
        window: day
    # Políticas:
    policies:
      # maxReasoningEffort é um id da PRÓPRIA rota (adapter-owned):
      maxReasoningEffort: medium
      allowedModels:
        - deepseek/deepseek-v4-flash
      denylistedProjects:
        - projeto-cliente-confidencial
    # Preço (cents por 1M tokens) — OPCIONAL. Por padrão o plugin resolve o
    # preço de cada modelo automaticamente (registry models.dev; veja abaixo),
    # então esta tabela só existe para override explícito. As chaves podem ser
    # o id do adapter (com prefixo de provider), o id nu, ou qualquer alias:
    pricingTable:
      deepseek/deepseek-v4.1-flash:
        inputCentsPerM: 15
        outputCentsPerM: 60
        cacheReadCentsPerM: 3
      gpt-4o:
        inputCentsPerM: 250
        outputCentsPerM: 1000
    # Escape hatch quando o id do adapter não é adivinhável:
    pricingAliases:
      vendor/opaque-model-v9: gpt-4o
    # Uma taxa ÚNICA opcional (cents por 1M) para modelos que nenhuma fonte
    # precifica — um knob, não uma tabela. Sem ela, chamadas sem preço entram
    # com custo zero mas marcadas como `unpriced` (nunca um zero silencioso).
    unpricedFallback:
      inputCentsPerM: 15
      outputCentsPerM: 60
```

**Config inválida falha o load**, com erro acionável, em vez de ligar um plugin
que não enforça nada: metade de um alvo de sync (só `baseUrl` ou só `orgKey`)
ou uma `cascade` que não intersecta `policies.allowedModels` são recusados no
boot. Preço **não** é exigido — o plugin resolve genericamente (abaixo); um
modelo sem preço é um estado visível (`unpriced`), não um boot falho.

## Como o preço é resolvido

O harness reporta o modelo com o id do **adapter** (normalmente com prefixo de
provider, ex. `deepseek/deepseek-v4-flash`), enquanto os catálogos de preço vêm
keyed por rota (`provider/model`). O plugin junta **duas fontes**, ambas
baixadas e cacheadas no libsql para uso offline:

- **registry** (`pricingRegistryUrl`, default `https://models.dev/api.json`) —
  catálogo de preços em USD por rota para 200+ providers. Cobre gateways que
  não publicam preço (ex. command-code) resolvendo cada modelo por id.
- **gateway** (`pricingGatewayUrl` + `pricingGatewayProvider`) — quando o
  gateway publica preço no próprio `/models` (OpenRouter, DeepInfra, …), esses
  números são **autoritativos** para as rotas dele.

A resolução de um id de adapter procura, nesta ordem:

1. `pricingAliases[model]` (explícito, sempre ganha)
2. chave exata na tabela local
3. rota `provider/model` no registry/gateway
4. id nu no registry (o id do adapter sem prefixo)
5. sufixos progressivos do id (ex. `provider/anthropic/x` → `anthropic/x` → `x`)

Modelo que nenhuma fonte precifica é gravado com **`unpriced: true`** (contado
e mostrado no painel) e logado — nunca um zero silencioso, porque um preço
zerado faz o fuse nunca cortar e o budget do servidor nunca disparar. Se a org
setou `unpricedFallback`, esses modelos usam a taxa única e o budget continua
cortando.

## O agente enxerga a política (model-facing tool)

A doc do harness prescreve o par: o gate diz *não* (o fuse em `agent/pre-step`)
— e uma **tool model-facing separada** deixa o próprio agente ler o estado da
política. Quando a composição monta o serviço `tools` (`@deepseek-ai/dsh-tools`),
o plugin registra `dsh_budget_status`: o modelo pode consultar, no meio da
sessão, os budgets em vigor por escopo (org/projeto/dev), o total já gasto vs o
limite, e se há um 429 remoto ativo (e até quando). É o que torna uma trava dura
tolerável — o agente entende por que foi cortado e pode adaptar (perguntar,
parar, escolher rota mais barata) em vez de morrer às cegas.

A tool é **só leitura**, nunca uma decisão: lê o mesmo libsql que o fuse enforça
(`spentForWindow`, `remoteBlockFor`, a política publicada) e formata uma visão.
Ela não gateia nem reescreve nada. O schema viaja em toda request, então quem
quiser zero presença na wire desliga com `budgetStatusTool: false` (default
`true`); e se o serviço `tools` não estiver montado, o registro é simplesmente
pulado — o plugin declara nenhum `inject`, então um serviço opcional nunca
segura o load.

## Modo local-only

Sem `baseUrl`/`orgKey` o plugin funciona **sozinho**: nada sobe, o fuse enforça
os budgets offline. As sessões ficam no libsql local, por padrão em
`$DSH_HOME/dsh-fuse/local.db` (`~/.dsh/...` quando `DSH_HOME` não está
definido) — ancorado no harness home, então o ledger não muda conforme o
diretório de onde o harness foi iniciado. `storeUrl` troca o caminho; um
caminho relativo só vale quando você o define explicitamente.

## O que sobe pro painel (sync)

A cada 60s (`syncIntervalMs`), um único batch (`POST /v1/usage/batch`):

- **usage events** — projeto, dev, modelo, provider, reasoning effort, tokens
  (entrada, saída, cache leitura, cache escrita), duração do step, custo e
  timestamp. O session id sai **hasheado (SHA-256) no cliente**; conteúdo nunca.
- **fuse cuts** — toda vez que o fuse travou uma chamada (regra + projeto), pro
  painel mostrar "quantas vezes a política cortou".

Um batch só marca as linhas como sincronizadas quando o SaaS **confirma** (2xx
com `ok`): um 500, um 502 do proxy ou uma página de erro nunca aposentam uma
linha sem ela ter sido gravada.

Um `429 BudgetExceeded { rule, reset_at }` do SaaS **engata o fuse local** até o
reset da janela — o time bloqueado centralmente fica bloqueado na máquina também.

## O painel como control plane

Além do 429, o plugin puxa `GET /v1/policy` (key-authed) no boot e a cada
`policyRefreshMs`: budgets e políticas `hard` da org, no vocabulário do fuse.
É isso que faz uma regra editada no painel chegar na máquina do dev — sem esse
pull, o fuse local só enforçaria o que o YAML do deployment diz. O resultado
fica em cache no libsql, então enforcement **não** depende da rede no boot.

## Alertas (50/80/95% + desvio)

Os thresholds graduados são disparados pelo backend (não pelo plugin) —
configure os canais no painel (**Alertas → Canais**): Telegram (bot token +
chat id) ou webhook (POST JSON `{kind, payload, at}`). O desvio de gasto acende
quando a última hora queima ≥ 5× a média das últimas 7 dias E ≥ US$ 1.

## Reasoning cap: por que não há lista fixa de valores

`ReasoningEffortId` é *adapter-owned*: o core do harness "brands identifiers but
does not enumerate their values; each adapter owns the ordered set". Então o cap
é comparado **por índice na lista de efforts da própria rota**
(`ctx.llm.resolveModelInfo`). Quando a rota não publica a lista, o cap é
reportado como **não enforçável** (`notEnforced`, com aviso no log) em vez de
adivinhado — um ranking local por nome, ou por código de caractere,
classificaria um id como `none` acima de `high` e travaria justamente a
requisição mais barata.

## GitHub Action

Veja `examples/agent-budget.yml`.

## Verificação

`pnpm dsh:smoke` (na raiz do monorepo) empacota o plugin, instala num profile
descartável com o `dsh plugin add` real, boota o harness headless e exige que o
fuse recuse um step que não cabe no budget e que um run permitido registre custo
**diferente de zero**.

## Licença

MIT.
