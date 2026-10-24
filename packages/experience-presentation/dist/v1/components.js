import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { HandIcon, RubberStamp } from "./icons.js";
import { EN_STATIC_COPY_V1 } from "./static-copy.js";
import { primitivesV1 } from "./types.js";
export const PRESENTATION_SCOPE_CLASS_V1 = "nexp-v1";
export function RichMessageV1({ segments, emphasisClassName = "" }) {
    return _jsx(_Fragment, { children: segments.map((segment, index) => segment.emphasis ? _jsx("span", { className: emphasisClassName, children: segment.text }, index) : segment.text) });
}
export function PresentationRootV1({ children, className = "" }) {
    return _jsx("div", { className: `${PRESENTATION_SCOPE_CLASS_V1} ${className}`, children: children });
}
const buttonBase = "inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-6 text-base font-extrabold transition-colors disabled:cursor-not-allowed disabled:opacity-60";
const buttonVariants = {
    primary: "bg-leaf text-ink hover:bg-leaf-hover",
    secondary: "bg-transparent text-ink shadow-[inset_0_0_0_1.5px_var(--color-ink)] hover:bg-sand",
    ghost: "text-moss underline-offset-4 hover:underline",
};
export const buttonClassV1 = (variant = "primary", extra = "") => `${buttonBase} ${buttonVariants[variant]} ${extra}`;
export function ButtonLinkV1({ href, children, variant = "primary", className = "", primitives }) {
    const { Link } = primitivesV1(primitives);
    return _jsx(Link, { href: href, className: buttonClassV1(variant, className), children: children });
}
export function SectionHeadingV1({ eyebrow, title, id, children, align = "start", action }) {
    const centered = align === "center";
    return _jsxs("div", { className: `mb-7 flex flex-wrap items-end gap-x-6 gap-y-3 ${centered ? "justify-center text-center" : "justify-between"}`, children: [_jsxs("div", { className: `max-w-2xl ${centered ? "mx-auto" : ""}`, children: [eyebrow ? _jsx("p", { className: "eyebrow mb-1.5", children: eyebrow }) : null, _jsx("h2", { id: id, className: "text-[2rem] sm:text-[2.75rem]", children: title }), children ? _jsx("div", { className: "mt-3 text-ink-soft", children: children }) : null] }), action] });
}
export function PhotoV1({ image, alt, sizes, priority = false, primitives, className = "", rounded = "rounded-[var(--radius-card)]", aspect = "aspect-[4/3]", imgClassName = "", emptyLabel = EN_STATIC_COPY_V1.text("common.imageComingSoon") }) {
    const { Image } = primitivesV1(primitives);
    return _jsx("div", { className: `relative overflow-hidden bg-sand ${aspect} ${rounded} ${className}`, children: image ? _jsx(Image, { src: image.src, srcSet: image.srcset, alt: alt, sizes: sizes, priority: priority, className: `absolute inset-0 h-full w-full object-cover ${imgClassName}`, style: { objectPosition: image.position } })
            : alt ? _jsx("span", { className: "flex h-full items-center justify-center text-sm text-muted", role: "img", "aria-label": alt, children: emptyLabel }) : null });
}
export function FaceBadgeV1({ face, primitives, className = "size-10 rounded-full text-base", sizes = "64px" }) {
    if (face.image)
        return _jsx("span", { "aria-hidden": true, className: `block overflow-hidden bg-sand ${className}`, children: _jsx(PhotoV1, { image: face.image, alt: "", sizes: sizes, primitives: primitives, aspect: "", rounded: "", className: "h-full w-full" }) });
    return _jsx("span", { "aria-hidden": true, className: `grid place-items-center bg-leaf-pale font-extrabold text-moss ${className}`, children: face.initial });
}
export function DecorativeVideoV1({ video, primitives, className = "" }) {
    const { Video = primitivesV1().Video } = primitivesV1(primitives);
    return _jsx(Video, { src: video.src, poster: video.poster, className: `h-full w-full object-cover ${className}` });
}
export function NoticeV1({ tone = "info", title, children, action, role, copy = EN_STATIC_COPY_V1 }) {
    const tones = {
        info: ["border-info/25 bg-info-pale text-info", "i", copy.text("notice.infoLabel")], warn: ["border-warn/25 bg-warn-pale text-warn", "!", copy.text("notice.warnLabel")],
        danger: ["border-danger/25 bg-danger-pale text-danger", "!", copy.text("notice.dangerLabel")], success: ["border-moss/25 bg-leaf-pale text-moss", "✓", copy.text("notice.successLabel")],
        neutral: ["border-line bg-sand text-ink-soft", "i", copy.text("notice.infoLabel")],
    };
    const [box, icon, label] = tones[tone];
    return _jsxs("div", { role: role, className: `flex gap-3 rounded-2xl border p-4 ${box}`, children: [_jsx("span", { "aria-hidden": true, className: "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-current text-sm font-black", children: _jsx("span", { className: "text-white mix-blend-normal", children: icon }) }), _jsxs("div", { className: "min-w-0 space-y-1", children: [_jsxs("p", { className: "font-bold", children: [_jsxs("span", { className: "sr-only", children: [label, ": "] }), title] }), children ? _jsx("div", { className: "text-ink-soft", children: children }) : null, action ? _jsx("div", { className: "pt-2", children: action }) : null] })] });
}
/** `aside`: inside a booking view's @container, from @4xl (56rem) the card turns into the right column's vertical summary (photo on top). */
export function BookingSummaryV1({ model, titleAs = "h1", primitives, aside = false, className = "" }) {
    const Title = titleAs;
    return _jsxs("div", { className: `mt-3.5 flex items-center gap-3.5 rounded-[20px] border border-line p-3 ${aside ? "@4xl:mt-[30px] @4xl:block @4xl:self-start @4xl:rounded-[26px] @4xl:p-4" : ""} ${className}`, children: [_jsx(PhotoV1, { image: model.image, alt: "", sizes: aside ? "(min-width: 64rem) 348px, 72px" : "72px", primitives: primitives, aspect: "", rounded: aside ? "rounded-[14px] @4xl:rounded-2xl" : "rounded-[14px]", className: aside ? "size-[72px] shrink-0 @4xl:aspect-[16/10] @4xl:h-auto @4xl:w-full" : "size-[72px] shrink-0" }), _jsxs("div", { className: aside ? "min-w-0 @4xl:mt-3.5" : "min-w-0", children: [_jsx(Title, { className: `font-display text-lg leading-[1.2] font-[450] tracking-[-0.01em] text-ink ${aside ? "@4xl:text-[1.3125rem]" : ""}`, children: model.title }), model.summary ? _jsx("p", { className: "mt-1 text-[0.84375rem] font-bold text-muted", children: model.summary }) : null] })] });
}
export function BookingStepHeadingV1({ id, step, label, children }) {
    return _jsxs("h2", { id: id, className: "mt-[30px] mb-3 text-[1.625rem] tracking-[-0.01em]", children: [_jsxs("span", { className: "hand mb-1 block text-[1.375rem]", children: [label, " ", step] }), children] });
}
// As an aside card (@4xl) the bar is a column: total and date on top, the action below. The phone row layout never applies there.
function barLayout(stack, aside) {
    if (stack)
        return aside ? "flex-col min-[30rem]:@max-4xl:flex-row min-[30rem]:@max-4xl:items-center min-[30rem]:@max-4xl:justify-between" : "flex-col min-[30rem]:flex-row min-[30rem]:items-center min-[30rem]:justify-between";
    return aside ? "items-center justify-between @4xl:flex-col @4xl:items-stretch @4xl:justify-start" : "items-center justify-between";
}
/** `aside`: inside a booking view's @container, from @4xl the bottom bar becomes an in-flow card that sticks below the header (total and date on top, action below). */
export function BookingBarV1({ total, line, action, stack = false, aside = false, className = "" }) {
    return _jsxs("div", { "data-sticky-bar": true, className: `sticky bottom-0 z-20 -mx-5 mt-10 flex gap-x-3 gap-y-2.5 border-t border-line bg-white/95 px-5 pt-3 pb-3.5 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10 ${barLayout(stack, aside)} ${aside ? "@4xl:top-[88px] @4xl:bottom-auto @4xl:m-0 @4xl:mt-4 @4xl:gap-y-4 @4xl:self-start @4xl:rounded-[26px] @4xl:border @4xl:border-line @4xl:bg-white @4xl:p-[22px] @4xl:shadow-[0_12px_36px_rgb(0_0_0/0.08)] @4xl:backdrop-blur-none" : ""} ${className}`, children: [_jsxs("div", { className: "min-w-0 leading-tight", "aria-live": "polite", children: [_jsx("p", { className: `text-sm text-ink-soft ${aside ? "@4xl:text-[0.9375rem]" : ""}`, children: total }), _jsx("p", { className: `mt-1 truncate text-[0.8125rem] font-extrabold text-moss ${aside ? "@4xl:text-sm @4xl:whitespace-normal" : ""}`, children: line })] }), action] });
}
export const BOOKING_FIELD_LABEL_CLASS_V1 = "mt-3.5 block text-[0.90625rem] font-extrabold";
export const BOOKING_FIELD_INPUT_CLASS_V1 = "mt-1.5 block min-h-[50px] w-full rounded-[14px] border border-line-strong bg-white px-3.5 py-3 text-base leading-snug font-normal text-ink focus-visible:border-transparent focus-visible:outline-offset-1 aria-[invalid=true]:border-danger";
export function ExperienceCardV1({ card, dates, highlight = null, variant = "home", priority = false, primitives, copy = EN_STATIC_COPY_V1 }) {
    const { Link } = primitivesV1(primitives);
    const list = variant === "list";
    return _jsxs("article", { className: "group relative flex h-full min-w-0 flex-col", children: [_jsxs("div", { className: "relative", children: [_jsx(PhotoV1, { image: card.cover, alt: card.cover?.alt || card.title, priority: priority, primitives: primitives, rounded: "rounded-[var(--radius-card)]", aspect: list ? "aspect-[4/3] sm:aspect-[4/5]" : "aspect-[4/5]", sizes: "(min-width: 64rem) 380px, (min-width: 40rem) 50vw, 85vw", emptyLabel: copy.text("common.imageComingSoon") }), card.groupLabel ? _jsx("span", { className: "absolute top-3 left-3 rounded-full bg-white/95 px-3 py-1 text-[0.8125rem] font-extrabold text-ink", children: card.groupLabel }) : null, _jsx(FaceBadgeV1, { face: card.face, primitives: primitives, className: "absolute right-3.5 -bottom-6 size-16 rounded-[18px] border-[3px] border-white text-2xl shadow-[0_6px_16px_rgb(0_0_0/0.14)]" })] }), _jsxs("div", { className: "flex flex-1 flex-col pt-3", children: [_jsx("p", { className: "min-h-[1.375rem] pr-20 text-sm font-bold text-muted", children: card.withLabel }), _jsx("h3", { className: "mt-1 text-[1.375rem] leading-[1.18]", children: _jsx(Link, { href: card.href, className: "bg-[linear-gradient(var(--color-leaf),var(--color-leaf))] bg-[length:0_3px] bg-[position:0_100%] bg-no-repeat transition-[background-size] duration-300 group-hover:bg-[length:100%_3px] after:absolute after:inset-0 focus-visible:outline-none group-has-[:focus-visible]:bg-[length:100%_3px]", children: card.title }) }), list ? _jsx("p", { className: "mt-2 line-clamp-2 text-[0.9375rem] text-ink-soft", children: card.lead }) : null, _jsxs("ul", { className: "mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1 text-sm font-bold text-ink-soft", children: [_jsxs("li", { className: "flex items-center gap-1.5", children: [_jsx(HandIcon, { name: "clock", className: "size-[22px]" }), card.durationLabel] }), card.language ? _jsxs("li", { className: "flex items-center gap-1.5", children: [_jsx(HandIcon, { name: "chat", className: "size-[22px]" }), _jsx("span", { "aria-hidden": true, children: card.language.short }), _jsx("span", { className: "sr-only", children: card.language.full })] }) : null, card.reviewLine ? _jsxs("li", { children: [_jsx("span", { "aria-hidden": true, children: card.reviewLine.text }), _jsx("span", { className: "sr-only", children: card.reviewLine.label })] }) : null] }), highlight ? _jsxs("p", { className: "mt-3 inline-flex h-7 items-center gap-1.5 self-start rounded-full bg-leaf-pale pr-3 pl-2 text-sm font-extrabold text-moss", children: [_jsx(HandIcon, { name: "cal", className: "size-5" }), highlight] }) : dates ?? (card.scheduleLabel ? _jsx("p", { className: "mt-3 h-7 text-sm font-bold text-muted", children: card.scheduleLabel }) : null), _jsx("p", { className: "mt-auto pt-3 text-[0.9375rem] text-ink-soft", children: _jsx(RichMessageV1, { segments: copy.rich(card.priceIsFrom ? "card.fromPriceRich" : "card.priceRich", { price: card.priceLabel }), emphasisClassName: "text-[1.1875rem] font-extrabold text-ink" }) })] })] });
}
export function InviteCardV1({ primitives, copy = EN_STATIC_COPY_V1 }) {
    const { Link } = primitivesV1(primitives);
    return _jsxs("article", { className: "flex aspect-[4/5] flex-col justify-center gap-3 rounded-[var(--radius-card)] border-[1.5px] border-dashed border-line-strong bg-sand p-7", children: [_jsx(HandIcon, { name: "house", className: "size-14" }), _jsx("p", { className: "hand text-[2.125rem]", children: copy.text("card.hostTitle") }), _jsx("p", { className: "text-[0.9375rem] text-ink-soft", children: copy.text("card.hostBody") }), _jsx(Link, { href: "/host", className: "link-leaf self-start", children: copy.text("card.hostCta") })] });
}
export function FigureV1({ value, unit, note }) {
    return _jsxs("li", { children: [_jsxs("p", { children: [_jsx("b", { className: "block font-display text-[3.875rem] leading-none font-light tracking-[-0.03em] lg:text-[5.5rem]", children: value }), _jsx("span", { className: "hand mt-0.5 block text-[1.875rem]", children: unit })] }), _jsx("p", { className: "mx-auto mt-2 max-w-[15rem] text-sm leading-[1.6] text-muted", children: note })] });
}
export { HandIcon, RubberStamp };
