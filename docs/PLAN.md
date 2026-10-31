# Antares: plano

Atualizado em 31/10/2026. A fase 1 está pronta e verificada nos editores reais (ver o [README](../README.md) e [PROTOCOL-NOTES.md](PROTOCOL-NOTES.md)). Este documento é o plano das próximas fases.

**Regra do projeto:** só prometemos o que o Muse oferece. Cada item abaixo diz de onde vem (contrato exportado, observado no host real, ou função só do lado da Antares) e o que é **desconhecido**. Um item só entra como pronto depois de ser exercitado no host real e na janela real do editor.

## Decisões já tomadas

| Tema | Decisão |
|---|---|
| Voz | Transcrição **local** (Whisper); o texto vai como parte `text` (o Muse não aceita áudio) |
| Interface | Webview próprio, igual no VS Code e no Antigravity IDE |
| Gasto | % das janelas 5 h e semanal, tokens locais, alertas (pronto) |
| Cliente | `muse serve` oficial por MSP; nunca ler `auth.json`, nunca chamar mint ou inferência por conta própria |

## Fase 1 (pronta)

Chat com streaming, copiar/colar, imagens (colar, soltar, anexar), perfil por chat, aprovações reais (rede e shell verificadas), seletor de modelo e de esforço, uso da assinatura com alertas e barra de status, histórico de sessões (continuar, ramificar). Verificada no VS Code 1.143.1 e no Antigravity IDE 1.107.0, inclusive com um turno real e aprovações reais na janela real.

## Fase 2: entrada e controle do chat

### 2A. Voz (pronta no Windows; detalhes em [VOICE.md](VOICE.md))

| Item | Origem | Estado |
|---|---|---|
| Botão de microfone no compositor, gravar e parar | cliente | **pronto**. O webview **nega** o microfone (medido no VS Code e no Antigravity IDE), então a gravação é feita pelo host da extensão (waveIn, 16 kHz, 16 bits) |
| Transcrição local; o texto cai no campo para revisar antes de enviar | cliente | **pronto**: faster-whisper (recomendado, instalação opcional com consentimento) e fala do Windows (precisa de reconhecedor instalado; não há nenhum nesta máquina) |
| Escolha do tamanho do modelo | cliente | **pronto** (`tiny`/`base`/`small`, padrão `base`) |
| Nada é enviado a serviços externos; o áudio é temporário e apagado | cliente | **pronto** (verificado nos testes) |
| Gravação em macOS e Linux | cliente | **pendente** (só o lado Whisper é multiplataforma) |
| Teste na janela real | cliente | **feito** no VS Code 1.143.1 e no Antigravity IDE 1.107.0 (falso, erro e microfone/Whisper reais) |

### 2B. Menu "+" do compositor (pronta; inspirada na segunda captura)

| Item da captura | O que o Muse oferece | Estado |
|---|---|---|
| **Adicionar arquivos ou fotos (Ctrl+U)** | Fotos: parte `image`. Arquivos: **só** menção `@caminho/relativo` no texto; não existe parte "arquivo" | **Pronto.** O seletor é do editor (o webview não abre diálogo de arquivo). Foto de até 5 MB vira miniatura (mesmas verificações de colar/soltar); arquivo dentro do workspace ou de uma pasta adicionada vira `@caminho` (com aspas se houver espaço, **palpite da Antares**, não verificado); arquivo fora das pastas é recusado com explicação, porque a ferramenta do host recusa. Pendente: arrastar do Explorer, "arquivo atual" e "seleção" |
| **Adicionar pasta** | `turn/start.workspaceRoots` (substituição persistente do conjunto) | **Pronto.** Pergunta antes (diálogo modal que diz o que concede e que **não** concede Project Trust), aparece como chip removível, vale a partir da próxima mensagem e termina com o chat. O host exige **caminho canônico** (`\\?\C:\...`), observado. **Não verificado com modelo real:** se a ferramenta de leitura de fato lê dentro da pasta adicionada |
| **Comandos de barra** | `skill/list` e parte `skill` | **Pronto.** `/` no início abre a paleta com as skills do host (origem, descrição, dica de argumento); Enter/Tab completa; `/skill args` vai como parte `skill` **só se** o seletor estiver na lista (o host recusa seletor desconhecido, observado). Pendente: `skill/import` |
| **Conectores** | `mcpServer/list` (experimental), OAuth, `session.config.mcpServers` na criação | **Lista somente leitura** (nome, origem, transporte, login). Adicionar, entrar (OAuth) e remover ficam na 3A |
| **Adicionar plugins** | `plugin/list`, `plugin/install`, `plugin/marketplace*` | **Lista somente leitura.** Instalar plugin executa código de terceiros: fica na 3A com confirmação e origem visíveis |
| **Fila (Ctrl+Enter)** | `turn/start.ifBusy`; `turn/unqueue` | **Pronto.** Com um turno em andamento, Enter orienta (`steer`) e Ctrl+Enter ou o botão Queue enfileira; a fila aparece acima do campo com "Remove" (`turn/unqueue`). `replace` não é oferecido (descartaria o turno em andamento). Remover uma mensagem já iniciada não foi exercitado no host real |

Verificado: 15 testes unitários novos (112 no total), host real com provedor echo (parte `skill`, `workspaceRoots` canônico, `@arquivo`), e janela real no VS Code 1.143.1 e no Antigravity IDE 1.107.0 (32 checagens cada, sem chamada de modelo). A fila só foi vista no host falso, no preview e com o host real em chamadas `turn/start` seguidas; um turno do provedor echo termina rápido demais para a janela real.

### 2C. Modos de permissão (inspirado na primeira captura)

Seletor com atalhos 1 a 5 e ciclo por Shift+Tab, mudando **sem perder a conversa**. O que o Muse realmente tem: quatro perfis e quatro modos de aprovação (`allowAll`, `promptUnmatched`, `onRequest`, `denyUnmatched`), trocados no meio da sessão por `session/setApprovalMode` (estável) e `session/setPermissionProfile` (experimental). Mapeamento proposto, **a confirmar por probes antes de ser prometido**:

| Modo na interface | Base no Muse | Estado do mapeamento |
|---|---|---|
| **Automático** (revisor decide, escala para você) | perfil `:auto-review` | Nunca exercitado no host real |
| **Manual** (pergunta antes de agir) | `:ask-me` + modo de aprovação mais estrito | Observado: `:ask-me` **não** pergunta por escrita no workspace; precisa de um modo mais estrito, a descobrir |
| **Aceitar edições** | Não existe como tal. Hoje o `:ask-me` já aceita escrita no workspace. Alternativa do lado da Antares: escolher "permitir na sessão" só para escrita no workspace, **nunca** shell ou rede | A Antares nunca decide sozinha; seria uma política escolhida pelo usuário, limitada e visível. Precisa observar pedidos de acesso a arquivo |
| **Plano** (planejar antes de alterar) | Não existe como tal. Do lado da Antares: perfil `:read-only` + pedido de plano, e um botão "aprovar plano" que troca o modo | Fluxo da Antares, não do Muse |
| **Ignorar permissões** | `:unrestricted` | Aviso forte e confirmação, como hoje. O sandbox do `muse serve` já foi visto indisponível |

Trocar de perfil no meio do chat: hoje reinicia o chat. A alternativa verificada é parar a sessão e **retomá-la com o novo perfil** (o `resume` aceita `permissionProfile`), preservando o histórico; a troca ao vivo por `setPermissionProfile` exige o modo experimental.

## Fase 3: conectores, navegador e imagens

### 3A. Conectores e plugins
Telas de gerenciamento (lista, estado de login OAuth, ativar), presets de conectores e `hook/list`. Depende de 2B.

### 3B. Acesso e controle de navegador

| Camada | O que existe | Plano |
|---|---|---|
| Ler a web | `web_fetch` e `web_search` (**observado**); pedem aprovação de rede por domínio | Já funciona; melhorar o cartão (domínio, regra que a opção cria) |
| Controlar um navegador | O "Computer Use" do host tem cartões de aprovação próprios (página, janela, passos, efeitos), mas o setup descrito é de **macOS** (`computerUseSetup`, "grants") e fica atrás de um gate. No Windows: **desconhecido** | Caminho realista: **servidor MCP de navegador** (por exemplo Playwright ou Chrome DevTools) configurado pelo usuário em 3A, com a Antares mostrando chamadas, capturas e aprovações |
| Aprovações de Computer Use | `ApprovalCuaCardFacts` no contrato | Renderizar o cartão (host da página, título da janela entre aspas, cada passo e seu efeito) se o host enviar; **nunca aprovar automaticamente** |
| Navegador do editor | O editor tem navegador embutido | Só como ideia: um MCP que controle esse navegador; fora do escopo até 3A funcionar |

Risco central: controle de navegador é a ação de maior impacto. Cada domínio e cada passo consequente exigem leitura do usuário; sessões de navegador com login do usuário são desaconselhadas por padrão.

### 3C. Mostrar e criar imagens na interface

| Caso | O que o contrato diz | Plano |
|---|---|---|
| Imagens que o **modelo viu** (capturas de uma ferramenta) | `ModelVisibleContent`: tipo, `mediaType`, dimensões, caminho; bytes por `item/readOutput` | Mostrar na linha da ferramenta, com limite de tamanho |
| Imagens referenciadas pelo assistente (arquivo no workspace, link em markdown) | Não é do protocolo | Mostrar **só** arquivos dentro do workspace, com limite de tamanho e sem buscar URL externa |
| O modelo **gerar** imagens | **Nada no contrato** sobre saída de imagem; o catálogo de modelos não declara modalidades | Condicionado: só habilitar se o host entregar o conteúdo. Hoje desconhecido |
| Mensagem do usuário com imagem | Só metadados voltam; os bytes não | Miniaturas locais (**pronto**) |

Também nesta fase: diffs no editor, terminal, worktrees (`session/start.worktree`).

## Fase 4
Vídeo (`media/upload` em chunks e parte `video`), acabamento, empacotamento (Open VSX e Marketplace) e release.

## Pendências e riscos conhecidos

- **Aprovações do host real ainda não vistas:** acesso a arquivo, socket Unix, vários estágios, `protectedWrite`, `judgeEscalated`, `:auto-review`.
- **Sandbox:** o `muse serve` reporta `sandboxAvailability: unavailable` mesmo com `sandbox windows check` em `ready`; causa desconhecida.
- **Contrato experimental** pode mudar entre versões do Muse; a Antares confere o fingerprint do schema.
- **O modelo contorna rejeições** (tentou shell depois de a rede ser rejeitada): cada cartão precisa ser lido.
- **Termos de uso da assinatura** não foram lidos; conferir antes de distribuir.
- **Memória da máquina:** pouca RAM livre; relevante para o tamanho do modelo de voz.
