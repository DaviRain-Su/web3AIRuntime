import type { PolicyAction, PolicyRule, PolicyContext } from "./types.js";

export interface RuleEvalResult {
  matched: boolean;
  action?: PolicyAction;
  message?: string;
  ruleName?: string;
}

// Token type for lexer
type Token =
  | { type: "ident"; value: string }
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "bool"; value: boolean }
  | { type: "op"; value: string }
  | { type: "lparen" }
  | { type: "rparen" }
  | { type: "and" }
  | { type: "or" }
  | { type: "not" }
  | { type: "eof" };

// Tokenize condition string
function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    const c = expr[i];

    // Skip whitespace
    if (/\s/.test(c)) {
      i++;
      continue;
    }

    // Parentheses
    if (c === "(") {
      tokens.push({ type: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "rparen" });
      i++;
      continue;
    }

    // Operators (==, !=, >=, <=, >, <)
    if (c === "=" && expr[i + 1] === "=") {
      tokens.push({ type: "op", value: "==" });
      i += 2;
      continue;
    }
    if (c === "!" && expr[i + 1] === "=") {
      tokens.push({ type: "op", value: "!=" });
      i += 2;
      continue;
    }
    if (c === ">" && expr[i + 1] === "=") {
      tokens.push({ type: "op", value: ">=" });
      i += 2;
      continue;
    }
    if (c === "<" && expr[i + 1] === "=") {
      tokens.push({ type: "op", value: "<=" });
      i += 2;
      continue;
    }
    if (c === ">") {
      tokens.push({ type: "op", value: ">" });
      i++;
      continue;
    }
    if (c === "<") {
      tokens.push({ type: "op", value: "<" });
      i++;
      continue;
    }

    // Logical operators
    if (expr.slice(i, i + 2) === "&&") {
      tokens.push({ type: "and" });
      i += 2;
      continue;
    }
    if (expr.slice(i, i + 2) === "||") {
      tokens.push({ type: "or" });
      i += 2;
      continue;
    }
    if (c === "!") {
      tokens.push({ type: "not" });
      i++;
      continue;
    }

    // String literals
    if (c === '"' || c === "'") {
      const quote = c;
      let value = "";
      i++;
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === "\\") {
          i++;
          if (i < expr.length) value += expr[i];
        } else {
          value += expr[i];
        }
        i++;
      }
      i++; // Skip closing quote
      tokens.push({ type: "string", value });
      continue;
    }

    // Numbers
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(expr[i + 1]))) {
      let numStr = c;
      i++;
      while (i < expr.length && /[0-9.]/.test(expr[i])) {
        numStr += expr[i];
        i++;
      }
      tokens.push({ type: "number", value: parseFloat(numStr) });
      continue;
    }

    // Identifiers (including dot paths like ctx.amount)
    if (/[a-zA-Z_]/.test(c)) {
      let ident = c;
      i++;
      while (i < expr.length && /[a-zA-Z0-9_.]/.test(expr[i])) {
        ident += expr[i];
        i++;
      }

      // Check for keywords
      if (ident === "true") {
        tokens.push({ type: "bool", value: true });
      } else if (ident === "false") {
        tokens.push({ type: "bool", value: false });
      } else if (ident === "and" || ident === "AND") {
        tokens.push({ type: "and" });
      } else if (ident === "or" || ident === "OR") {
        tokens.push({ type: "or" });
      } else if (ident === "not" || ident === "NOT") {
        tokens.push({ type: "not" });
      } else {
        tokens.push({ type: "ident", value: ident });
      }
      continue;
    }

    // Unknown character - skip
    i++;
  }

  tokens.push({ type: "eof" });
  return tokens;
}

// Get value by dot path from context
function getByPath(obj: any, path: string): any {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// Simple recursive descent parser for expressions
class Parser {
  private pos = 0;
  private tokens: Token[];
  private ctx: Record<string, any>;

  constructor(tokens: Token[], ctx: Record<string, any>) {
    this.tokens = tokens;
    this.ctx = ctx;
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { type: "eof" };
  }

  private advance(): Token {
    return this.tokens[this.pos++] ?? { type: "eof" };
  }

  // expression: orExpr
  parse(): boolean {
    const result = this.orExpr();
    return result;
  }

  // orExpr: andExpr (('||' | 'or') andExpr)*
  private orExpr(): boolean {
    let left = this.andExpr();
    while (this.peek().type === "or") {
      this.advance();
      const right = this.andExpr();
      left = left || right;
    }
    return left;
  }

  // andExpr: notExpr (('&&' | 'and') notExpr)*
  private andExpr(): boolean {
    let left = this.notExpr();
    while (this.peek().type === "and") {
      this.advance();
      const right = this.notExpr();
      left = left && right;
    }
    return left;
  }

  // notExpr: ('!' | 'not')? comparison
  private notExpr(): boolean {
    if (this.peek().type === "not") {
      this.advance();
      return !this.comparison();
    }
    return this.comparison();
  }

  // comparison: primary (op primary)?
  private comparison(): boolean {
    const left = this.primary();

    const t = this.peek();
    if (t.type === "op") {
      this.advance();
      const right = this.primary();
      return this.compare(left, t.value, right);
    }

    // Boolean coercion if no operator
    return Boolean(left);
  }

  // primary: '(' expression ')' | literal | identifier
  private primary(): any {
    const t = this.peek();

    if (t.type === "lparen") {
      this.advance();
      const result = this.orExpr();
      if (this.peek().type === "rparen") {
        this.advance();
      }
      return result;
    }

    if (t.type === "number") {
      this.advance();
      return t.value;
    }

    if (t.type === "string") {
      this.advance();
      return t.value;
    }

    if (t.type === "bool") {
      this.advance();
      return t.value;
    }

    if (t.type === "ident") {
      this.advance();
      return getByPath(this.ctx, t.value);
    }

    // Default
    this.advance();
    return undefined;
  }

  private compare(left: any, op: string, right: any): boolean {
    switch (op) {
      case "==":
        return left === right;
      case "!=":
        return left !== right;
      case ">":
        return Number(left) > Number(right);
      case ">=":
        return Number(left) >= Number(right);
      case "<":
        return Number(left) < Number(right);
      case "<=":
        return Number(left) <= Number(right);
      default:
        return false;
    }
  }
}

// Evaluate a condition expression against context
export function evaluateCondition(condition: string, ctx: Record<string, any>): boolean {
  try {
    const tokens = tokenize(condition);
    const parser = new Parser(tokens, ctx);
    return parser.parse();
  } catch {
    return false;
  }
}

// Evaluate a single rule against context
export function evaluateRule(rule: PolicyRule, ctx: PolicyContext): RuleEvalResult {
  const matched = evaluateCondition(rule.condition, ctx as Record<string, any>);

  if (matched) {
    return {
      matched: true,
      action: rule.action,
      message: rule.message,
      ruleName: rule.name,
    };
  }

  return { matched: false };
}

// Evaluate all rules, return first matching rule with block/confirm/warn action
export function evaluateRules(rules: PolicyRule[], ctx: PolicyContext): RuleEvalResult | null {
  for (const rule of rules) {
    const result = evaluateRule(rule, ctx);
    if (result.matched && result.action !== "allow") {
      return result;
    }
  }
  return null;
}
