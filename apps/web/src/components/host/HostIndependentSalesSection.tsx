import { HOST_SURFACE, consoleButtonClass } from "./host-ui";

/*
 * 「独立 10%（自分の Stripe で販売）」(3c-2, #726, docs/host-payouts.md) の欄。料金・予約のタブに出す。
 * 出るのは、flag が ON で、販売者が自分の Stripe アカウントのホスト（商品の `independentSales` が null でない）だけ。
 * プランが無い商品は「選ぶ」、代理受領の商品は「切り替える」（受付中でもできる）、独立 10% の商品は今のプランを見せる。
 */

export interface IndependentSalesOffer {
  readonly agreementVersion: string;
  /** The seller name the product is sold under (the host's seller profile, which is its public NATIVE disclosure). */
  readonly sellerName: string;
}

export interface IndependentSalesProduct {
  readonly independentSales?: IndependentSalesOffer | null;
  readonly salesPlan: null | {
    readonly current: { readonly revision: number; readonly plan?: string; readonly agreementVersion: string; readonly chargeMode?: string; readonly sellerParty?: string };
    readonly phase?: string;
    readonly pending?: { readonly plan?: string; readonly agreementVersion?: string } | null;
    readonly transitionCommandId?: string | null;
  };
}

export const isIndependentSalesPlan = (product: Pick<IndependentSalesProduct, "salesPlan">): boolean =>
  product.salesPlan?.current.plan === "INDEPENDENT_10" && product.salesPlan.current.chargeMode === "CONNECT_DIRECT";

const isAgentPlan = (product: Pick<IndependentSalesProduct, "salesPlan">): boolean =>
  product.salesPlan?.current.chargeMode === "PLATFORM" && product.salesPlan.current.sellerParty === "PROVIDER";

/**
 * "choose": the product has no plan. "switch": it is sold with 代理受領 now. "resume": a switch to 独立 10% stopped half way (the old Checkouts are
 * not all reconciled), finished with the same command. null: nothing to choose (already 独立 10%, or another plan).
 */
export function independentSalesAction(product: IndependentSalesProduct): "choose" | "switch" | "resume" | null {
  if (!product.independentSales) return null;
  if (product.salesPlan === null) return "choose";
  if (product.salesPlan.phase !== undefined && product.salesPlan.phase !== "ACTIVE") {
    return product.salesPlan.pending?.plan === "INDEPENDENT_10" && product.salesPlan.transitionCommandId ? "resume" : null;
  }
  return isAgentPlan(product) ? "switch" : null;
}

export function HostIndependentSalesSection({ product, busy, dirty, accepted, onAccept, retrying, onChoose }: {
  product: IndependentSalesProduct;
  busy: boolean;
  dirty: boolean;
  accepted: boolean;
  onAccept: (value: boolean) => void;
  /** 同じ command の結果の再確認（直前の通信の結果が分からない）。 */
  retrying: boolean;
  onChoose: () => void;
}) {
  const offer = product.independentSales;
  if (!offer) return null;
  const action = independentSalesAction(product);
  if (action === "resume") {
    return <section className={`${HOST_SURFACE} space-y-3 p-4 md:p-5`} aria-labelledby="independent-sales-resume-title">
      <h2 id="independent-sales-resume-title" className="font-extrabold">独立 10% への切り替えが途中です</h2>
      <p className="text-sm text-ink-soft">旧決済の照合が終わっていません。新しい予約は、終わるまで受け付けられません。</p>
      <button type="button" disabled={busy} className={consoleButtonClass("primary")} onClick={onChoose}>旧決済の照合を再開</button>
    </section>;
  }
  return <>
    {isIndependentSalesPlan(product) ? <section className={`${HOST_SURFACE} space-y-2 p-4 md:p-5`} aria-labelledby="independent-sales-current-title">
      <h2 id="independent-sales-current-title" className="font-extrabold">独立 10%（自分の Stripe で販売）</h2>
      <p className="text-sm text-ink-soft">販売者はあなた（{offer.sellerName}）です。旅行者の代金は、あなたの Stripe アカウントで直接受け取ります（版 {product.salesPlan!.current.revision}）。</p>
    </section> : null}
    {action !== null ? <section className={`${HOST_SURFACE} space-y-3 p-4 md:p-5`} aria-labelledby="independent-sales-title">
      <h2 id="independent-sales-title" className="font-extrabold">独立 10%（自分の Stripe で販売）</h2>
      {action === "switch" ? <p className="text-sm text-ink-soft">いまは「サポート 15%（NIHO が代金を受け取る）」です。受付中でも切り替えられます。切り替え前に受けた予約は、今までどおり受取口座へ送金されます。</p> : null}
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li>販売者はあなた（{offer.sellerName}）です。</li>
        <li>代金は、あなたの Stripe アカウントで直接受け取ります。</li>
        <li>料率は10%です（決済手数料こみ。NIHO が補います）。</li>
        <li>返金・異議申立ての損失は、あなたの負担です。</li>
      </ul>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={accepted} disabled={busy} onChange={(event) => onAccept(event.target.checked)} className="mt-1" /><span>上の内容と<a className="underline" href="/host/terms" target="_blank" rel="noreferrer">規約</a>（同意版 {offer.agreementVersion}）を確認し、同意します。</span></label>
      <button type="button" disabled={busy || dirty || !accepted} className={consoleButtonClass("primary")} onClick={onChoose}>{retrying ? "同じ操作の結果を確認" : action === "switch" ? "独立 10% に切り替える" : "独立 10% で売る"}</button>
    </section> : null}
  </>;
}
