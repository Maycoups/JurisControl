# Contrato de dados — busca de jurisprudência

Formato exato usado hoje entre o front-end do JurisControl e a Edge
Function `busca-jurisprudencia` (ver código completo em
`referencia-codigo-atual/busca-jurisprudencia.ts`). Se a base de dados
nova expuser resultados nesse mesmo formato, a troca do lado do
JurisControl vira só apontar pra fonte nova — não precisa mudar nenhum
componente de tela.

## Requisição

```jsonc
POST /busca-jurisprudencia
Authorization: Bearer <token de usuário autenticado do JurisControl>
Content-Type: application/json

{
  "termo": "cobrança de honorários advocatícios",   // obrigatório — texto livre
  "uf": "RJ"                                        // opcional — hoje só usado como dica de escopo geográfico, não filtra de fato no LexML/eproc
}
```

- `termo` hoje chega de duas formas: (a) derivado automaticamente das 8
  primeiras palavras da ação do processo, ou da área do processo se a
  ação estiver vazia; (b) digitado livremente pelo usuário num campo
  editável (ver `termoBusca`/`termoAutomatico` no front). Não assuma
  jargão jurídico formatado — pode vir texto corrido, inclusive
  publicação bruta do diário oficial nos casos de processos importados
  automaticamente.
- `uf` também aparece como `process.uf || 'RJ'` — ou seja, hoje o
  fallback é sempre RJ quando o processo não tem UF cadastrada. Não é um
  filtro obrigatório rígido — é aceitável devolver resultados de fora
  dessa UF quando fizer sentido (o próprio LexML já agrega nacionalmente).

## Resposta

```jsonc
{
  "resultados": [
    {
      "titulo": "Acórdão — Processo 0001234-56.2024.8.19.0001",
      "ementa": "APELAÇÃO CÍVEL. COBRANÇA DE HONORÁRIOS ADVOCATÍCIOS. (...)", // até ~400 caracteres hoje
      "tribunal": "TJRJ — 5ª Câmara Cível — Rel. Fulano de Tal",             // texto livre, já formatado pra exibir direto
      "data": "2024-03-15",                                                  // ISO (YYYY-MM-DD) quando possível; string livre como fallback aceitável
      "urn": "0001234-56.2024.8.19.0001",                                    // identificador do julgado (número do processo, URN LexML, ou equivalente)
      "link": "https://...",                                                 // link público pra consulta processual/íntegra — opcional mas muito valorizado (vira link clicável na tela)
      "decisaoIntegral": "texto completo da decisão, se disponível"          // opcional — quando presente, a tela mostra um botão "Ver decisão completa"
    }
  ],
  "fonte": "lexml",     // string livre identificando de onde veio — aparece na tela como "Real (<fonte>)"
  "mensagem": "3 resultado(s) reais do LexML."   // texto livre, mostrado como legenda pro usuário
}
```

Campos obrigatórios de fato pro card de resultado não quebrar:
`titulo`, `ementa`, `tribunal`. Os demais (`data`, `urn`, `link`,
`decisaoIntegral`) são todos opcionais — a tela já trata ausência de
cada um graciosamente (ver `JurisprudenciaResultCard` no `index.html` do
JurisControl, não incluído nesta pasta por não ser relevante isolado).

### Regra inegociável: nunca dado simulado

Se não houver resultado real pra devolver, a resposta certa é
`resultados: []` com uma `mensagem` explicando o motivo — nunca inventar
ou aproximar um resultado. Essa é uma decisão de produto já tomada e
comunicada ao usuário na própria tela ("Real (`<fonte>`)" aparece só
quando há retorno de verdade).

## Onde isso é consumido hoje (2 pontos de chamada)

1. **Aba "Jurisprudência" da ficha do processo** — busca automática ao
   abrir a ficha (termo derivado do processo) + busca manual (usuário
   edita o termo e re-executa). Mostra `mensagem`, os `resultados` em
   grade de 2 colunas, e link — quando presente — pra abrir a consulta
   processual em nova aba.
2. **Criação de Peças com IA** — busca automática antes de gerar a
   minuta (termo derivado do tipo de peça/ação/instruções), os
   `resultados` entram no prompt da IA como fundamentação real e
   aparecem citados numa lista lateral ao lado do documento gerado.
