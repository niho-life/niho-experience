import { HOST_SURFACE, consoleButtonClass } from "./host-ui";

/*
 * 「サポート 15%（NIHO が代金を受け取る）」(代理受領, #725, docs/host-payouts.md) の欄。料金・予約のタブに出す。
 * 出るのは、flag が ON で販売者プロフィールの無いホスト（商品の `agentSales` が null でない）だけ。
 */

export interface AgentSalesOffer {
  readonly agreementVersion: string;
  readonly receiverName: string;
  readonly payoutDelayDays: number;
  /** The host's public (NATIVE) seller name; null when it has none yet. */
  readonly sellerName: string | null;
  /** 代理受領の版があるとき：その版の販売者名。無ければ null。 */
  readonly planSellerName?: string | null;
  /** 代理受領の版があるとき：OWNER の同意が今も数えられるか（撤回・OWNER の交代で false）。 */
  readonly consentCounted?: boolean;
  /** false: the host has a seller profile now (its own Stripe account), so a product still sold with 代理受領 is shown but cannot be chosen again. */
  readonly choosable?: boolean;
}

export interface AgentSalesProduct {
  readonly bookingOpen?: boolean;
  readonly agentSales?: AgentSalesOffer | null;
  readonly salesPlan: null | {
    readonly current: { readonly revision: number; readonly agreementVersion: string; readonly chargeMode?: string; readonly sellerParty?: string };
  };
}

export const isAgentSalesPlan = (product: Pick<AgentSalesProduct, "salesPlan">): boolean =>
  product.salesPlan?.current.chargeMode === "PLATFORM" && product.salesPlan.current.sellerParty === "PROVIDER";

/**
 * 選べる（選び直せる）か。受付中は出さない。プランが無ければ選べる。代理受領の版があるときは、同意の版が今の版と違う、同意が数えられなくなった
 * （撤回・OWNER の交代）、NATIVE の名前と版の名前が違う（停止中の改名）のどれかで選び直せる。
 */
export function agentSalesChoosable(product: AgentSalesProduct): boolean {
  const offer = product.agentSales;
  if (!offer || offer.choosable === false || product.bookingOpen === true) return false;
  if (product.salesPlan === null) return true;
  if (!isAgentSalesPlan(product)) return false;
  return product.salesPlan.current.agreementVersion !== offer.agreementVersion
    || offer.consentCounted === false
    || (offer.sellerName !== null && offer.planSellerName !== undefined && offer.planSellerName !== null && offer.planSellerName !== offer.sellerName);
}

export function HostAgentSalesSection({ product, busy, dirty, accepted, onAccept, retrying, onChoose, sellerHref }: {
  product: AgentSalesProduct;
  busy: boolean;
  dirty: boolean;
  accepted: boolean;
  onAccept: (value: boolean) => void;
  /** 同じ command の結果の再確認（直前の通信の結果が分からない）。 */
  retrying: boolean;
  onChoose: () => void;
  sellerHref: string;
}) {
  const offer = product.agentSales;
  if (!offer) return null;
  const choosable = agentSalesChoosable(product);
  return <>
    {isAgentSalesPlan(product) ? <section className={`${HOST_SURFACE} space-y-2 p-4 md:p-5`} aria-labelledby="agent-sales-current-title">
      <h2 id="agent-sales-current-title" className="font-extrabold">サポート 15%（NIHO が代金を受け取る）</h2>
      <p className="text-sm text-ink-soft">販売者はあなたです。旅行者の代金は{offer.receiverName}が代わりに受け取り、体験が終わったあとにあなたの受取口座へ送ります（版 {product.salesPlan!.current.revision}）。</p>
    </section> : null}
    {choosable ? <section className={`${HOST_SURFACE} space-y-3 p-4 md:p-5`} aria-labelledby="agent-sales-title">
      <h2 id="agent-sales-title" className="font-extrabold">サポート 15%（NIHO が代金を受け取る）</h2>
      <p className="text-sm text-ink-soft">受取口座を登録しなくても、予約を受け付けられます。送金までに受取口座が必要です。</p>
      {offer.sellerName === null ? <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950">先に<a className="underline" href={sellerHref}>販売者表示</a>で、特定商取引法に基づく表記を保存してください。</p> : null}
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li>販売者はあなた（{offer.sellerName ?? "販売者表示で入力した名前"}）です。</li>
        <li>代金は{offer.receiverName}があなたに代わって受け取ります。旅行者は、支払った時点で支払いを済ませたことになります。</li>
        <li>料率は15%です（決済手数料こみ。返金後の額に対して）。</li>
        <li>体験が終わってから{offer.payoutDelayDays}日後に、予約ごとに受取口座へ送ります。</li>
        <li>送金のあとの返金・異議申立ては、送金の取り消しか、次の送金からの差し引きで精算します。</li>
      </ul>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={accepted} disabled={busy || offer.sellerName === null} onChange={(event) => onAccept(event.target.checked)} className="mt-1" /><span>上の内容と<a className="underline" href="/host/terms" target="_blank" rel="noreferrer">規約</a>（同意版 {offer.agreementVersion}）を確認し、同意します。</span></label>
      <button type="button" disabled={busy || dirty || !accepted || offer.sellerName === null} className={consoleButtonClass("primary")} onClick={onChoose}>{retrying ? "同じ操作の結果を確認" : "この方法で売る"}</button>
    </section> : null}
  </>;
}
