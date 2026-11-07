// 账单与发票结构化提取领域模型定义

export type DocumentType = "bank_statement" | "invoice" | "receipt";

export type ExtractionMode = "llm_live" | "demo_sample" | "heuristic_fallback";

export type TransactionCategory =
  | "Revenue & Payouts"
  | "Cloud & SaaS"
  | "Payroll & Contractors"
  | "Office & Operations"
  | "Marketing & Ads"
  | "Travel & Meals"
  | "Taxes & Fees"
  | "Equipment & Hardware"
  | "Transfer"
  | "Uncategorized";

export interface TransactionItem {
  id: string;
  date: string; // YYYY-MM-DD
  description: string;
  merchant: string;
  category: TransactionCategory;
  type: "credit" | "debit";
  amount: number; // 始终为非负数值，正负方向由 type 决定
  taxAmount?: number;
  confidence: number; // 0.0 - 1.0
}

export interface ReconciliationSummary {
  openingBalance: number;
  closingBalance: number;
  totalCredits: number;
  totalDebits: number;
  calculatedClosing: number;
  discrepancy: number;
  isBalanced: boolean;
}

export interface ExtractionMeta {
  modeUsed: ExtractionMode;
  providerName: string;
  modelName: string;
  latencyMs: number;
  warnings: string[];
}

export interface ExtractionResult {
  documentTitle: string;
  institution: string;
  documentType: DocumentType;
  accountOrInvoiceNumber: string;
  statementPeriod: string;
  currency: string;
  transactions: TransactionItem[];
  reconciliation: ReconciliationSummary;
  meta: ExtractionMeta;
}

export interface AIConfigSettings {
  provider: "demo" | "openai_compatible";
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type PlanTier = "free" | "pro" | "business";

export interface BillingState {
  plan: PlanTier;
  creditsUsed: number;
  creditsLimit: number; // Pro / Business 下为 999999
  customerEmail?: string;
  activatedAt?: string;
}
