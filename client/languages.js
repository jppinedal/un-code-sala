import { StreamLanguage } from '@codemirror/language';

// Cada lenguaje se carga bajo demanda (esbuild genera un fragmento por import()).
const legacy = (mode) => StreamLanguage.define(mode);

const loaders = {
  plaintext: async () => [],
  javascript: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  typescript: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  python: () => import('@codemirror/lang-python').then((m) => m.python()),
  java: () => import('@codemirror/lang-java').then((m) => m.java()),
  c: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.c)),
  cpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  csharp: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.csharp)),
  go: () => import('@codemirror/lang-go').then((m) => m.go()),
  rust: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  php: () => import('@codemirror/lang-php').then((m) => m.php()),
  ruby: () => import('@codemirror/legacy-modes/mode/ruby').then((m) => legacy(m.ruby)),
  swift: () => import('@codemirror/legacy-modes/mode/swift').then((m) => legacy(m.swift)),
  kotlin: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.kotlin)),
  dart: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.dart)),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  xml: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  toml: () => import('@codemirror/legacy-modes/mode/toml').then((m) => legacy(m.toml)),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  shell: () => import('@codemirror/legacy-modes/mode/shell').then((m) => legacy(m.shell)),
  powershell: () => import('@codemirror/legacy-modes/mode/powershell').then((m) => legacy(m.powerShell)),
  r: () => import('@codemirror/legacy-modes/mode/r').then((m) => legacy(m.r)),
  julia: () => import('@codemirror/legacy-modes/mode/julia').then((m) => legacy(m.julia)),
  octave: () => import('@codemirror/legacy-modes/mode/octave').then((m) => legacy(m.octave)),
  lua: () => import('@codemirror/legacy-modes/mode/lua').then((m) => legacy(m.lua)),
  perl: () => import('@codemirror/legacy-modes/mode/perl').then((m) => legacy(m.perl)),
  haskell: () => import('@codemirror/legacy-modes/mode/haskell').then((m) => legacy(m.haskell)),
  dockerfile: () => import('@codemirror/legacy-modes/mode/dockerfile').then((m) => legacy(m.dockerFile)),
};

/** Devuelve la extensión de CodeMirror del lenguaje (o ninguna si no se pudo cargar). */
export async function loadLanguage(id) {
  try {
    return await (loaders[id] ?? loaders.plaintext)();
  } catch (err) {
    console.error(`No se pudo cargar el lenguaje ${id}`, err);
    return [];
  }
}
