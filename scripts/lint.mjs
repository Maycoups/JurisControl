#!/usr/bin/env node
// Linter do JurisControl — não existe bundler nesse projeto (index.html é
// React+JSX transpilado ao vivo no navegador via Babel Standalone, de
// propósito, pra manter a velocidade de iteração), então um ESLint
// tradicional de projeto-com-build não se aplica bem aqui. Em vez disso,
// este script faz o que de fato importa pra esse tipo de arquitetura:
// tenta *transpilar de verdade* o mesmo bloco de código que o navegador vai
// rodar (usando a mesma engine, @babel/standalone) e relata qualquer erro
// de sintaxe/JSX com arquivo e linha exatos — formalizando a checagem
// manual de "contagem de chaves" usada ao longo do desenvolvimento.
//
// Também faz uma checagem de sintaxe (não de tipos — ver limitação abaixo)
// nas Edge Functions do Supabase.
//
// LIMITAÇÃO CONHECIDA: as Edge Functions são TypeScript de verdade, mas
// rodam no runtime do Deno (imports "npm:pacote", global `Deno`, etc.) —
// o `tsc` do TypeScript não entende esses imports, e não há `deno` CLI
// instalado neste ambiente pra rodar `deno check` (o checador de tipos real
// do Deno). Por isso este script só confirma que a SINTAXE de cada function
// é válida (via parser TypeScript do Babel, sem checagem de tipos). Erros
// de tipo só apareceriam no deploy (`supabase functions deploy`), que já
// falha alto e claro quando isso acontece. Se quiser checagem de tipos de
// verdade localmente, instale o Deno CLI e rode `deno check
// supabase/functions/*/index.ts`.
//
// Uso: node scripts/lint.mjs   (ou `npm run lint`)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Babel from '@babel/standalone';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let erros = 0;

function relatarErro(arquivo, err) {
  erros++;
  const local = (err.loc && `linha ${err.loc.line}, coluna ${err.loc.column}`) || 'posição desconhecida';
  console.error(`\n❌ ${arquivo} (${local})`);
  console.error(`   ${err.message.split('\n')[0]}`);
}

// --- 1) index.html: extrai o <script type="text/babel"> e transpila com a
// mesma engine que o navegador usa (React + JSX + sintaxe moderna). ---
function lintIndexHtml() {
  const arquivo = 'index.html';
  const caminho = path.join(ROOT, arquivo);
  const src = fs.readFileSync(caminho, 'utf8');

  const marcaAbertura = '<script type="text/babel">';
  const inicio = src.indexOf(marcaAbertura);
  if (inicio === -1) {
    relatarErro(arquivo, { message: `Não encontrei ${marcaAbertura} — o arquivo mudou de estrutura?` });
    return;
  }
  const fim = src.indexOf('</script>', inicio);
  const codigo = src.slice(inicio + marcaAbertura.length, fim);

  // Checagem rápida de balanceamento (chaves/parênteses/colchetes) — pega
  // desbalanceamento grosseiro antes mesmo de tentar transpilar.
  let chave = 0, parenteses = 0, colchete = 0;
  for (const ch of codigo) {
    if (ch === '{') chave++; else if (ch === '}') chave--;
    else if (ch === '(') parenteses++; else if (ch === ')') parenteses--;
    else if (ch === '[') colchete++; else if (ch === ']') colchete--;
  }
  if (chave !== 0 || parenteses !== 0 || colchete !== 0) {
    relatarErro(arquivo, {
      message: `Desbalanceamento: chaves=${chave} parênteses=${parenteses} colchetes=${colchete} (deveriam ser 0)`,
    });
  }

  try {
    Babel.transform(codigo, {
      presets: ['react', 'env'],
      filename: arquivo,
      sourceType: 'script',
    });
    console.log(`✅ ${arquivo}: sintaxe/JSX válidos (${codigo.split('\n').length} linhas de script).`);
  } catch (err) {
    relatarErro(arquivo, err);
  }
}

// --- 2) Edge Functions: checa só sintaxe TypeScript (ver limitação no topo
// do arquivo — não é checagem de tipos). ---
function lintEdgeFunctions() {
  const dirFunctions = path.join(ROOT, 'supabase', 'functions');
  if (!fs.existsSync(dirFunctions)) return;

  for (const nome of fs.readdirSync(dirFunctions)) {
    const dirFn = path.join(dirFunctions, nome);
    if (!fs.statSync(dirFn).isDirectory()) continue;
    const caminhoIndex = path.join(dirFn, 'index.ts');
    if (!fs.existsSync(caminhoIndex)) continue;

    const relativo = path.relative(ROOT, caminhoIndex).replace(/\\/g, '/');
    const codigo = fs.readFileSync(caminhoIndex, 'utf8');
    try {
      Babel.transform(codigo, {
        presets: ['typescript'],
        filename: relativo,
        sourceType: 'module',
      });
      console.log(`✅ ${relativo}: sintaxe válida.`);
    } catch (err) {
      relatarErro(relativo, err);
    }
  }

  const caminhoShared = path.join(dirFunctions, '_shared', 'auth.ts');
  if (fs.existsSync(caminhoShared)) {
    const relativo = path.relative(ROOT, caminhoShared).replace(/\\/g, '/');
    const codigo = fs.readFileSync(caminhoShared, 'utf8');
    try {
      Babel.transform(codigo, { presets: ['typescript'], filename: relativo, sourceType: 'module' });
      console.log(`✅ ${relativo}: sintaxe válida.`);
    } catch (err) {
      relatarErro(relativo, err);
    }
  }
}

lintIndexHtml();
lintEdgeFunctions();

console.log('');
if (erros > 0) {
  console.error(`✗ ${erros} erro(s) encontrado(s).`);
  process.exit(1);
} else {
  console.log('✓ Tudo certo, sem erros de sintaxe.');
  process.exit(0);
}
