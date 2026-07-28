export type DefKind = 'class' | 'function' | 'constant' | 'type';

export interface DefQuery {
  name: string;
  file: string;
  line: number;
  lang: 'kotlin';
}

export interface DefLocation {
  path: string;
  line: number;
  column: number;
  kind: DefKind;
}

export interface SymbolResolver {
  buildIndex(repoRoot: string, revision: string): Promise<void>;
  resolve(repoRoot: string, revision: string, query: DefQuery): Promise<DefLocation[]>;
}
