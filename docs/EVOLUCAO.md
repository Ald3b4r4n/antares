# Evolução do Antares: auditoria e fases

Registro em português da auditoria de 2026-11-02 (Muse Code 1.4.14, HEAD `55327d5`) e do andamento das fases. Cada fase termina com testes e aprovação; nada é publicado sem autorização.

## Achados da auditoria (resumo)

- O contrato real do Muse vem de `muse schema generate-json-schema [--experimental]` (70 métodos estáveis, 105 com os experimentais). É a fonte de verdade, acima das notas históricas.
- **Contributor:** a chave `contributor_mode_enabled` fica em `settings/read` (valor salvo, não o efetivo quando há `--contributor-mode`); a escrita é por `settings/writeValue` (experimental, chave oculta). Contributor significa que o conteúdo pode ser usado pela Meta para melhorar produtos.
- **Skills:** o estado de ativação (`on`, `userInvocableOnly`, `off`) só aparece em `muse skills list|inspect --json`; o `skill/list` do protocolo não o traz.
- **MCP:** o binário aceita `mcpServers` e `mcp_servers` com `{transport: "stdio"|"streamable_http", mode, ...}`; `mcpServer/list` só mostra servidores da sessão (capacidade `sessionMcp`), não os do `settings.json`.
- **Plugins:** o ciclo completo (inspecionar, aprovar, habilitar, atualizar, remover) existe na CLI; o protocolo só tem instalar, listar e marketplaces.
- **Muse Image:** sem superfície no protocolo; na documentação oficial é uma API com chave e cobrança por imagem. Fica desabilitado.

## Fases

| Fase | Assunto | Estado |
|---|---|---|
| B1 | Catálogo de modelos: erro visível, "pode estar desatualizado", botão ↻ Models, aviso de mudança de catálogo e de modelo que sumiu | **Feita e aprovada** |
| B2 | Modalidade Standard/Contributor: indicador somente leitura e troca para Standard com confirmação | **Feita e aprovada** |
| C | Gerenciador de skills | **Feita e aprovada** |
| D | Gerenciador de MCP | **Feita e aprovada** (chamada de ferramenta provada, inclusive com o seu MCP de imagem) |
| E | Plugins e marketplaces | **Feita** |
| E2 | Catálogos sugeridos (marketplace oficial de plugins, coleção de skills) e marketplaces próprios | **Feita** (aguarda aprovação) |
| B3 | Acompanhar mudança de plano (relê o catálogo de modelos e avisa de modelos novos) | **Feita** (aguarda aprovação) |
| H | Acesso à web: ligar/desligar `web_fetch` e `web_search` e mostrar o estado | **Feita** (aguarda aprovação) |
| I | Pré-visualização de página (landing page) dentro do editor | **Feita** (aguarda aprovação) |
| F | Muse Image | **Bloqueada pelo protocolo; documentada** |
| G | Convergência e documentação final | **Feita** (versão 0.2.0 empacotada; nada publicado) |

## B1: o que mudou

- `refreshModels()` não engole mais erros: mantém o último catálogo válido, emite `modelsStatus` (`stale`, motivo, hora da última leitura boa, origem do catálogo) e avisa uma vez por sequência de falhas. Uma lista vazia depois de um catálogo bom é tratada como falha, não como "sem modelos".
- Mudanças no catálogo (modelo novo ou removido, por exemplo depois de login, troca de conta ou assinatura) geram um aviso com os ids.
- Se o modelo lembrado deixou de existir, o chat avisa e volta ao padrão (antes só voltava em silêncio).
- Botão **↻ Models** pede o catálogo de novo, sem chamada de modelo; a etiqueta "model list may be out of date" aparece quando a última leitura falhou, com o motivo e a hora no texto de ajuda.
- Não incluído: leitura da conta (`account/read`) exige a API experimental no host principal; fica para a fase B2, junto do restante das leituras experimentais.
- Testes: 6 novos unitários (host falso com `FAKE_MUSE_LIST=fail|empty|drop|add`) e 3 checks e2e novos nos dois editores (65/65).

## B2: modalidade Standard / Contributor

- **Indicador somente leitura** ("Contributor", "Standard" ou "Mode: not confirmed") nos controles do chat, com texto de ajuda e um diálogo explicando o que cada modalidade significa para os dados e em que o estado se baseia.
- **Honestidade sobre o estado:** o Muse só informa o valor *salvo* (`settings/read`), não o que está em vigor. Por isso o indicador mostra "não confirmado" quando não há valor salvo (o padrão documentado das assinaturas é Contributor), quando `MUSE_CONTRIBUTOR_MODE` está definido no ambiente do editor, ou quando a leitura falha. "Confirmado" significa apenas "é o valor salvo e o Antares não o sobrescreve".
- **Leitura real:** num teste de leitura na sua conta o indicador mostrou "Contributor" (valor salvo `true`).
- **Troca:** só **para Standard** (`settings/writeValue contributor_mode_enabled=false`), com um segundo diálogo de confirmação, e o resultado é verificado (se o host responder que o valor continua diferente de Standard, o Antares avisa o erro). A troca para Contributor **não** é oferecida: o Muse registra o reconhecimento do aviso de uso de dados numa chave que um cliente não consegue gravar, então isso é feito no próprio Muse (`/settings`, linha Contributor mode).
- **Medido em HOME isolada** (sem tocar na sua conta): a escrita persiste no `settings.json`, é lida de volta e um valor inválido é recusado com erro. **Não verificado:** o que acontece com uma sessão já aberta (a documentação diz "a partir da próxima requisição"). A troca na sua conta real não foi exercitada.
- Testes: 10 unitários novos (`test/unit/contributor.test.ts`, host falso) e 4 checks e2e nos dois editores (69/69).

## C: gerenciador de skills

- **Onde:** menu "+" > **Manage skills…** (painel próprio, responsivo, com busca e filtro: todas, suas, de projeto, de plugins, internas, "desligadas ou com problemas").
- **Fonte dos dados:** `muse skills list --json` (a CLI oficial). Ao contrário do `skill/list` do protocolo, ela traz o **estado de ativação** (`on`, `user-invocable-only`, `off`), escopo, origem, caminho, diagnósticos e o custo estimado em tokens no início de cada conversa. Um estado que o Antares não reconhece aparece como **unknown**, nunca como ligado.
- **Ativação real:** o seletor de cada skill chama `muse skills enable|user-only|disable` e **lê a lista de volta**; só diz que funcionou se a lista concordar (a CLI poderia responder "ok" e não ter mudado nada). A mudança vale para chats novos; um chat já aberto mantém as skills com que começou (comportamento observado antes para plugins; não reverificado para skills).
- **Usar:** o botão **Use** coloca `/nome ` na caixa de mensagem (desabilitado para skills desligadas). O `/skill` digitado e a paleta continuam como antes.
- **Conflitos:** um nome oferecido por mais de uma skill (por exemplo uma sua e uma interna) é sinalizado com os escopos de cada uma; qual roda depende da precedência do Muse e o painel diz para conferir.
- **Instalar de pasta:** Muse valida a pasta (`skills validate`, não instala nada), o diálogo mostra as ferramentas que ela pede e os avisos, e só então instala no escopo do usuário (`skills install`; um id já existente só é substituído com confirmação). **Remover** (`skills uninstall`) só aparece para skills instaladas na pasta do Muse e pede confirmação. **Import…** reaproveita a importação existente (pré-visualização, depois confirmação).
- **Instalar de repositório Git:** continua **bloqueado**: a CLI só instala de uma pasta local (`install <path>`), então o Antares não inventa esse caminho.
- **Projeto:** a listagem passa o workspace mas **não** o marca como confiável, então skills de projeto só aparecem depois que a pasta for confiável no Muse.
- **Verificado com a CLI real em HOME isolada** (nada seu foi tocado; o `settings.json` real manteve data e tamanho): validar, instalar, listar, desligar, "só usuário", religar, recusar id repetido e desinstalar; e ligar/desligar uma skill interna (o escopo aparece como `bundled` na lista e `built-in` nos comandos, e o Antares faz a conversão).
- **Não coberto em janela real:** os diálogos modais de instalar e remover (o e2e não clica diálogos nativos); estão cobertos por testes unitários do módulo e pela execução do módulo contra a CLI real.
- Testes: 9 unitários novos (`test/unit/skillscli.test.ts`, CLI falsa em `test/fixtures/fake-muse-cli.mjs`) e 7 checks e2e novos nos dois editores (74/74).

## D: gerenciador de MCP

### O que foi medido (sem modelo, em config isolada)
- **O Muse carrega servidores MCP do `settings.json` com as duas grafias**, `mcpServers` e `mcp_servers`: um servidor de teste recebeu `initialize`, `notifications/initialized` e `tools/list` (descoberta de ferramentas confirmada), tanto por `muse exec` quanto por `muse serve`. Entrada com `enabled: false` não é iniciada.
- **Quando:** no `serve`, os servidores começam no **primeiro turno** da sessão, não em `session/start`. Um servidor `required` que não inicia aborta a execução com "Required MCP server `x` failed during startup: ..."; `optional` é pulado.
- **Formato por servidor:** `{transport: "stdio"|"streamable_http", command/args/env/framing | url/headers, mode: "required"|"optional", enabled}`. O `type: "http"` das notas antigas está obsoleto. O processo filho só recebe as variáveis de `env` explícitas.
- **Bug encontrado e corrigido:** `mcpServer/list` **não mostra** servidores definidos no `settings.json` (nem os dois da sua conta), então o painel de Connectors dizia "nenhum conector" para quem tem servidores. Agora a fonte desses servidores é o próprio arquivo; o host só acrescenta o estado de login e os servidores vindos de plugins e sessões.

### O que o painel faz (menu "+" > Connectors)
- Lista os servidores do `settings.json` (nome, transporte, modo, alvo sem segredos, nomes das variáveis de ambiente e cabeçalhos, problemas de validação) e avisa quando o arquivo usa as duas grafias ou é JSON inválido (nesse caso nada é editado).
- **Adicionar** (local/stdio ou HTTP), **Editar**, **Desligar/Ligar** e **Remover**, cada um com confirmação mostrando o que muda (sem valores secretos), arquivo e backup. Segredos são digitados mascarados; a página sugere `${VARIAVEL}` para não gravá-los no arquivo.
- **Segurança da escrita:** só o servidor nomeado muda (as outras configurações, a ordem das chaves, outros servidores e os campos desconhecidos e segredos do servidor editado são preservados); gravação atômica (arquivo temporário e renomeação), backup `settings.json.antares-bak-<data>`, recusa se o arquivo mudou desde a leitura, recusa JSON inválido. A grafia da chave existente é mantida (arquivo novo usa `mcpServers`, como o seu e a ajuda da CLI).
- **Test:** pede ao próprio Muse que inicie **um** servidor, numa configuração limpa e descartável (`muse exec --provider echo`, sem modelo, sem custo), forçado a `required` para que a falha apareça; segredos vão pelo ambiente do processo como referências `${VAR}`, nunca para o disco. Pede confirmação antes, porque inicia o programa configurado. Prova: o Muse consegue iniciá-lo e o handshake responde. Não prova: chamada de ferramenta, arquivos da sua pasta pessoal, login salvo de servidor HTTP.
- **Camadas de estado mostradas:** configurado (está no arquivo), ligado/desligado, modo, "iniciou e respondeu" ou o motivo de não iniciar (após Test), login (ou "sign-in not reported" quando o host não informa). "Funcional" (ferramenta chamada) só é provado numa conversa e não é exibido como fato.
- **Aplicação:** vale para chats novos; um chat já aberto mantém os servidores com que começou (comportamento esperado pelo início no primeiro turno; não reverificado para sessão aberta).

### Não coberto / pendente
- **Prova da chamada de ferramenta (feita, com a sua autorização, um turno real):** `scripts/probe-mcp-call.ts` rodou o modelo real numa config isolada com só o servidor de teste inofensivo (uma ferramenta, `antares_ping`), modo Standard forçado, perfil `:unrestricted` e esforço `minimal`. O servidor registrou `initialize`, `notifications/initialized`, `tools/list` e `tools/call` com `{name: "antares_ping", arguments: {text: "abc123"}}`, e a resposta do modelo trouxe `pong:abc123`. Ou seja, **configurar, descobrir e chamar** funcionam de ponta a ponta com um servidor definido no `settings.json`. O login foi ligado por link físico (não copiado) à config isolada; a primeira tentativa falhou por falta de credencial na pasta isolada, sem consumir modelo. Seu `settings.json` real não foi tocado.
- Os fluxos de caixas de entrada de **Adicionar** e **Editar** não têm check e2e (as caixas de texto nativas não são clicáveis pelo teste); a lógica que eles usam (validação, edição, gravação) está coberta por testes unitários. Lista, Test, Desligar e Remover passam em janela real, incluindo os diálogos de confirmação.
- Login OAuth de servidor definido no `settings.json` continua pelo método do host; como o host não lista esses servidores, o botão "Sign in" aparece para HTTP com estado "não informado" e o resultado é mostrado como vier (não exercitado contra um provedor).
- Testes: 22 unitários novos (`mcpsettings`, `mcpprobe`) e 6 checks e2e novos nos dois editores (79/79).

## Teste com os seus MCPs (Fase D, complemento)

Com a sua autorização, os três servidores que você usa foram exercitados: `ai-memory`, `aldebaran-imagens` e `rea`. O Test do Antares pediu ao Muse que iniciasse cada um numa configuração limpa e os três iniciaram e responderam. Num turno real do Muse em sessão isolada (config, home e workspace descartáveis, modo Standard forçado, login ligado por link físico), o modelo chamou `image_providers`, `generate_image` e `image_job_status` do `aldebaran-imagens`: o job terminou `completed` em 44 s e gerou um PNG válido de 1,0 MB na pasta de dados do próprio MCP (o worker de imagens foi iniciado com o script do projeto, que é idempotente). O `ai-memory` e o `rea` só foram iniciados, sem chamada de ferramenta.

## E: gerenciador de plugins e marketplaces

- **Onde:** menu "+" > **Plugins** (e, dentro dele, **Marketplaces…**).
- **Fonte dos dados:** `muse plugins list|inspect --json` (CLI oficial), com o MSP como reserva se a CLI falhar. A CLI diz o que o MSP não diz: o que cada plugin traz e o **estado de revisão de cada parte que executa código**.
- **Modelo de confiança (como o Muse declara):** as skills de um plugin ficam ativas enquanto ele está habilitado; **hooks e servidores MCP** precisam de revisão antes de rodar (`review_needed`), e uma definição alterada exige nova revisão. Estados lidos: `review_needed`, `trusted_enabled` (aprovado, roda), `trusted_disabled` (rejeitado, não roda); um estado desconhecido aparece como "state not reported", nunca como aprovado.
- **Nada é aprovado automaticamente.** Listar nunca decide nada (há teste que garante isso). Cada hook ou servidor MCP tem **Approve…** e **Reject** próprios: aprovar mostra o evento e o comando (ou o comando/origem do servidor) e avisa que roda no seu computador, com as suas permissões e **fora do sandbox do Muse**; a aprovação vale para aquela definição exata.
- **Ciclo de vida, cada passo com confirmação e leitura de volta:** habilitar/desabilitar (um plugin desabilitado não carrega hooks nem MCP, e a página diz isso), atualizar (copia de novo da origem; se uma definição mudou, ela volta a "waiting for your review"), remover (os dados do plugin são mantidos). Se a CLI responder "ok" mas o estado não mudar, o Antares mostra erro em vez de sucesso.
- **Marketplaces:** a visão lista cada catálogo (tipo, origem, quantidade de plugins) com **Refresh** (baixa a lista de novo; não instala nada) e **Remove** (os plugins já instalados ficam). Adicionar continua pelo fluxo existente, que agora também atualiza a visão.
- **Instalar** continua como antes (pasta validada ou par marketplace, com pré-visualização do que o plugin traz).
- **Medido na CLI real em HOME isolada** (nada seu foi tocado): validar, instalar, aprovar o hook (`trusted_enabled`), rejeitar o MCP (`trusted_disabled`), desabilitar/habilitar, atualizar (a aprovação foi mantida quando nada mudou), remover, e listar/atualizar/remover marketplace. O seletor de capacidade usa `mcp_server` (não `mcp`). Um plugin desabilitado não lista capacidades de execução no `inspect`.
- **Não coberto:** habilitar um plugin de terceiros real (você não tem plugins instalados; o e2e usa um plugin de demonstração com skill, hook de `echo` e o servidor MCP de teste), e o efeito de aprovar em uma sessão já aberta (a documentação diz que vale para chats novos). Instalação de marketplace por Git não foi exercitada.
- Testes: 9 unitários novos (`test/unit/pluginscli.test.ts`, CLI falsa) e 9 checks e2e novos nos dois editores (88/88).

## Adendos ao plano (2026-11-02)

Pedidos feitos depois da auditoria e incluídos no plano:

- **E2, catálogos de fábrica:** a extensão deve oferecer, logo no início, alguns marketplaces (plugins e coleções de skills) e deixar o usuário adicionar os seus. Decisão de segurança: **a extensão não altera a configuração do Muse sozinha ao ser instalada**. Ela mostra uma oferta única na primeira abertura ("adicionar os catálogos sugeridos?") e uma seção "Suggested" na visão de Marketplaces, e só adiciona depois do aceite. Plugins de marketplace continuam exigindo a aprovação de hooks e MCP.
- **B3, seguir o plano da assinatura:** o catálogo de modelos vem do host a cada leitura, então um plano maior passa a aparecer quando ele é relido. A etapa faz o Antares reler ao detectar troca do nome do plano (`usage/read` traz `tierName`), ao voltar o foco à janela e periodicamente, e avisar de modelos novos. Limite: o host não devolve modelos que a conta não acessa, então não há como mostrar "bloqueado por plano".
- **H, acesso à web:** o Muse já tem as ferramentas nativas `web_fetch` e `web_search` (observado em turno real: o modelo buscou uma página e respondeu a partir dela; o acesso de rede pede aprovação por domínio). As chaves `tools.web_fetch.enabled` e `tools.web_search.mode` (`client`, `hosted`, `off`) são do host e graváveis. Falta mostrar e alternar isso no Antares.
- **I, pré-visualização de página:** o Antares não tem navegador próprio. Plano: abrir no navegador embutido do editor (Simple Browser) uma URL local detectada na saída do agente (servidor de desenvolvimento) ou digitada, e servir um HTML estático da pasta de trabalho por um servidor local somente de leitura, preso a 127.0.0.1, para ver uma landing page sem servidor próprio. Controle de navegador pelo agente (clicar, preencher) continua dependendo de um servidor MCP de navegador configurado pelo usuário (ver `docs/BROWSER.md`).

### Resultado da verificação de catálogos reais (CLI do Muse, HOME isolada, Git por HTTPS)

- `anthropics/claude-plugins-official`: adicionado em 19 s, **29 plugins utilizáveis**. Os demais apontam para outros repositórios ou usam `git-subdir` (não suportado pelo Muse) e foram pulados pelo próprio Muse, alguns por erro de clonagem no Windows ("could not create work tree dir ... Invalid argument", caminho estendido `\\?\`).
- `anthropics/claude-plugins-community`: adicionado em 152 s, **só 4 plugins utilizáveis** pelo mesmo motivo. **Não entra como sugerido** (lento e quase tudo é pulado).
- `anthropics/skills`: **não é um marketplace para o Muse** (0 plugins: as entradas não têm manifesto de plugin), mas é uma coleção de skills no padrão `SKILL.md`. Entra como **coleção de skills**: o Antares baixa o repositório (clone raso), lista as skills e instala as escolhidas pelo mesmo caminho validado da Fase C.

## E2: catálogos sugeridos e marketplaces próprios

- **Visão de Marketplaces** (Plugins > Marketplaces…): seção **"Suggested to start with"** com dois catálogos, cada um adicionado só por um botão e depois de um diálogo que mostra a origem e o que esperar:
  - **Anthropic's official plugins** (`anthropics/claude-plugins-official`, Git por HTTPS), adicionado pela CLI do Muse (cerca de 20 s): 29 plugins utilizáveis.
  - **Anthropic's Agent Skills** (`anthropics/skills`), uma **coleção de skills** (não é marketplace do Muse): o Antares baixa o repositório (clone raso em pasta temporária, só HTTPS, nada é executado), lista as 20 skills, deixa escolher, o Muse valida cada uma e só então instala (mesmo caminho da Fase C). Verificado de verdade: as 8 primeiras foram validadas pelo Muse.
- **Marketplace próprio:** continua pelo **Add marketplace…** (pasta ou URL Git).
- **Oferta única na primeira abertura:** um aviso (não modal) pergunta se você quer ver os catálogos sugeridos; nada é adicionado sem escolha, e a configuração `antares.offerCatalogs` desliga o aviso. **Por que não "já instalado"?** Alterar a configuração do Muse sozinho ao instalar a extensão seria mudar uma configuração global sem consentimento, então o padrão é *disponível e oferecido*, não *adicionado*.
- **Fora da lista de propósito:** `claude-plugins-community` (152 s para adicionar e só 4 plugins utilizáveis, o resto é pulado pelo Muse) pode ser adicionado manualmente.
- **Limites do Muse com catálogos de terceiros (medidos):** entradas com `git-subdir` não são suportadas e algumas clonagens falham no Windows ("could not create work tree dir ... Invalid argument", caminho estendido). Plugins de terceiros continuam exigindo a aprovação individual de hooks e MCP (Fase E).
- **Testes:** 7 unitários (`test/unit/catalogs.test.ts`: lista sugerida, só HTTPS e nenhum transporte que executa comandos, varredura de skills inclusive descrições em bloco YAML, clone raso e limpeza, `marketplace add` com leitura de volta) e 1 check e2e.

## B3: acompanhar o plano da assinatura

- O Antares relê o catálogo de modelos (**sem chamada de modelo**) quando o nome do plano muda (`usage/read` traz `tierName`; um aviso diz "Your Muse plan changed (A to B)") e quando a janela volta ao foco com a última leitura com 10 minutos ou mais (e nunca durante um turno). Modelos novos aparecem no seletor e no aviso de mudança de catálogo da Fase B1.
- **Limites:** não dá para mostrar o Muse Wonder Full "bloqueado": o host não devolve modelos que a conta não acessa. Um upgrade real não pôde ser simulado aqui; a lógica de decisão (`planWatch.ts`, 4 testes) e a releitura do catálogo (B1) estão testadas com host falso.

## H: acesso à web

- O Muse já tem as ferramentas **`web_fetch`** (ler uma página) e **`web_search`**; nos testes reais o modelo buscou uma página e respondeu a partir dela. Sob os modos de permissão mais restritos, alcançar um site pede aprovação por domínio.
- O botão **"Web: …"** mostra o estado real lido do Muse (`tools.web_fetch.enabled` e `tools.web_search.mode`: `client`, `hosted`, `off`; os nomes são do Muse e o Antares não afirma mais do que isso) e abre um menu para mudar, com confirmação e leitura de volta. Valia para chats novos.
- **Medido na CLI real em HOME isolada:** padrão "Web: on"; desligar a leitura, trocar a busca para `hosted` e `off`, e restaurar, tudo lido de volta.
- 5 testes unitários (`test/unit/websettings.test.ts`) e 2 checks e2e.

## I: pré-visualização de página

- O botão **Preview** abre, no navegador do próprio editor, (a) um endereço local que as ferramentas do agente imprimiram (um servidor de desenvolvimento; o botão passa a "Preview ●"), (b) um endereço http(s) digitado, ou (c) um arquivo HTML da pasta, servido **somente leitura em 127.0.0.1** por um servidor pequeno do Antares enquanto o chat está aberto (com confirmação na primeira vez).
- **Segurança do servidor:** só GET e HEAD; só responde ao próprio nome de host (sem DNS rebinding); não sai da pasta (testado com `..`, codificações, barras invertidas, `//`, byte nulo e link simbólico); nunca serve arquivos que começam com ponto (`.env`, `.git`); `no-store` e `nosniff`; sem listagem de diretório.
- **Verificado em janela real nos dois editores:** no VS Code abre o *Simple Browser* (aba "Landing (127.0.0.1:porta)"); no Antigravity abre a aba **"Jetski Preview"** (o navegador próprio dele). O conteúdo e o CSS carregam, e um dotfile e um caminho fora da pasta são recusados.
- **Não coberto:** o agente *controlar* o navegador (clicar, preencher) continua dependendo de um servidor MCP de navegador configurado por você (ver `docs/BROWSER.md`); e a página aberta no navegador do editor não é "vista" pelo modelo. 8 testes unitários (`test/unit/preview.test.ts`) e 4 checks e2e.

## F: Muse Image (bloqueado, sem simulação)

- **Investigado:** o esquema do Muse 1.4.14 (70 métodos estáveis, 105 com os experimentais) não tem método, evento nem ferramenta de geração ou edição de imagem; a única ocorrência de "image" é o tipo de **entrada** do turno. Nenhuma ferramenta nativa de imagem apareceu nos turnos reais. Não há como descobrir a capacidade, pedir uma geração nem receber um arquivo de resultado pelo MSP.
- **Documentação oficial:** o Muse Image é o modelo `muse-image-1.0`, acessado por uma **API de imagens** (`/v1/images/generations` e `/v1/images/edits`, ou a ferramenta `image_generation` do Responses API) com **chave de API e cobrança de US$ 0,01 por imagem**. A página de planos diz que o plano Everyday "inclui acesso a Muse Image", mas **não diz como isso é usado dentro do Muse Code**, e a página de autenticação descreve só cobrança por uso de tokens ou assinatura.
- **Decisão:** respeitando a restrição de não integrar API paga por consumo, não pedir chave e não presumir que a assinatura cobre chamadas externas, **nenhuma geração de imagem foi implementada e nada foi simulado**. Não há botão nem seletor de Muse Image.
- **O que já funciona e continua:** anexar imagens, ver imagens do workspace, e usar um **MCP de imagem seu** pelo Muse (provado: o `aldebaran-imagens` gerou uma imagem em um turno real). Se o Muse passar a expor uma ferramenta de imagem, ela aparecerá como qualquer outra ferramenta nos cartões, e a investigação deve ser refeita com o esquema novo (`muse schema generate-json-schema --experimental`).

## G: convergência

- Regressão completa: `tsc`, testes unitários, e2e em janela real no VS Code e no Antigravity IDE nos modos padrão, de modos de permissão, de importação de skills e de plugins.
- Documentação em português (este arquivo) e em inglês/português (README, INSTALL) atualizada; `BROWSER.md` e `PROTOCOL-NOTES.md` corrigidos com o que foi medido; versão 0.2.0 no `package.json`.
- **Nada foi commitado, publicado, tagueado nem instalado nos editores** nesta rodada: depende da sua autorização.
