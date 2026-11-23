// Оформлення замовлення: POST /api/shops/<slug>/orders.
// Сервер сам перевіряє наявність і перераховує ціни за своєю базою,
// а замовлення надсилає власнику магазину в Telegram.

import { shopSlug } from '../config/shop';

export type DeliveryMethod = 'np_branch' | 'np_locker' | 'ukrposhta' | 'courier';

export interface OrderLine {
  productId: string;
  name: string;
  brand: string;
  selection: Record<string, string>;
  selectionLabel: string;
  qty: number;
  unitPrice: number;
}

export interface OrderDraft {
  customer: { fullName: string; phone: string };
  delivery: { city: string; method: DeliveryMethod; point: string };
  comment: string;
  lines: OrderLine[];
  total: number;
  /** initData з Telegram — сервер перевіряє його підпис. */
  telegramInitData?: string;
}

export type OrderResult = { mode: 'live'; orderId: string };

export async function submitOrder(draft: OrderDraft): Promise<OrderResult> {
  let res: Response;
  try {
    res = await fetch(`/api/shops/${shopSlug()}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: draft.customer,
        delivery: draft.delivery,
        comment: draft.comment,
        lines: draft.lines.map((l) => ({ productId: l.productId, selection: l.selection, qty: l.qty })),
        telegramInitData: draft.telegramInitData,
      }),
    });
  } catch {
    throw new Error('Немає з’єднання з інтернетом');
  }
  const data = (await res.json().catch(() => ({}))) as { orderId?: string; error?: string };
  if (!res.ok || !data.orderId) throw new Error(data.error || 'Не вдалося надіслати замовлення');
  return { mode: 'live', orderId: data.orderId };
}
