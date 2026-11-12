// Tremendous API shapes we read. Only the fields we use; the API returns more.
export interface Recipient {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}
export interface Money {
  denomination: number;
  currency_code?: string;
}
export type DeliveryStatus = "SCHEDULED" | "FAILED" | "SUCCEEDED" | "PENDING";
export type DeliveryMethod = "EMAIL" | "LINK" | "PHONE";

export interface Reward {
  id: string;
  order_id?: string;
  created_at?: string;
  deliver_at?: string | null;
  expires_at?: string | null;
  value?: Money;
  recipient?: Recipient;
  delivery?: { method?: DeliveryMethod; status?: DeliveryStatus; link?: string };
  custom_fields?: { id?: string; value?: unknown; label?: string }[];
}

export type OrderStatus =
  | "CANCELED"
  | "OPEN"
  | "EXECUTED"
  | "FAILED"
  | "PENDING APPROVAL"
  | "PENDING INTERNAL PAYMENT APPROVAL"
  | "PENDING SETTLEMENT";

export interface Order {
  id: string;
  external_id?: string | null;
  campaign_id?: string | null;
  created_at: string;
  status: OrderStatus;
  channel?: string;
  payment?: { subtotal?: number; total?: number; fees?: number; currency_code?: string };
  rewards?: Reward[];
}
