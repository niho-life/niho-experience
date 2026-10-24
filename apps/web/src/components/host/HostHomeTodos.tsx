"use client";

import Link from "next/link";
import { useState } from "react";
import type { HomeApproval, HomeTodo } from "@/host/home";
import { HOST_MESSAGES_PATH, withProvider } from "@/lib/host/routes";
import { useFocusAfterRender } from "./editor-parts";
import { BookingDecisionDialog } from "./HostBookingDialogs";
import { HostIcon } from "./HostIcon";
import { consoleButtonClass, HOST_SURFACE, LIST_ROW, LIST_ROW_DETAIL, LIST_ROW_TITLE } from "./host-ui";
import { MoreLink, RatingStars, SectionTitle, StatusPill } from "./ui";

const HEADING = "home-todo";

/**
 * ホーム's 次にすること (#106, the journey mock's H1): one row per request with the time left
 * (承認する asks in the bookings screen's dialog), per thread waiting for an answer (返信する),
 * per review to answer or read (#108, a few of them), then drafts and listings under review.
 * "メッセージを見る ›" opens every thread.
 *
 * 承認 takes the row away and says so here (mock mode: nothing is kept, as on 予約).
 * TODO(#87): send 承認 to NIHO and read the request back.
 */
export function HostHomeTodos({ todos: initialTodos, providerId }: { todos: readonly HomeTodo[]; providerId: string | null }) {
  const [todos, setTodos] = useState<readonly HomeTodo[]>(initialTodos);
  const [asking, setAsking] = useState<HomeApproval | null>(null);
  const [notice, setNotice] = useState("");
  const focusLater = useFocusAfterRender();
  const link = (href: string) => withProvider(href, providerId);

  /** The row is gone with its button: focus goes to the panel's title, and the result is said there. */
  const approve = (approval: HomeApproval) => {
    setTodos(todos.filter((todo) => todo.approval?.bookingId !== approval.bookingId));
    setNotice(`${approval.booking.guest} さんの申込を承認しました`);
    focusLater(HEADING);
  };

  return (
    <section aria-labelledby={HEADING} className={HOST_SURFACE}>
      <div className="flex items-center justify-between gap-2.5 px-4 pt-4 pb-2 md:px-5">
        <SectionTitle id={HEADING} focusable>
          次にすること
        </SectionTitle>
        <MoreLink href={link(HOST_MESSAGES_PATH)}>メッセージを見る</MoreLink>
      </div>
      <p role="status" className={notice ? "mx-4 mb-2 flex items-start gap-1.5 rounded-xl bg-leaf-pale px-3 py-2 text-[0.8125rem] leading-normal font-bold text-moss md:mx-5" : "sr-only"}>
        {notice ? (
          <>
            <HostIcon name="check" className="mt-0.5 size-4" />
            {notice}
          </>
        ) : null}
      </p>
      {todos.length ? (
        <ul>
          {todos.map((todo) => (
            <li key={todo.key} className={`${LIST_ROW} flex-wrap border-t border-line first:border-t-0 max-md:items-start`}>
              {todo.status ? <StatusPill status={todo.status} /> : null}
              {/* 170px keeps the pill and the words on one line down to a 320px phone; the buttons wrap below. */}
              <div className="min-w-0 flex-[1_1_170px]">
                {todo.aside ? <p className={`text-xs leading-normal font-extrabold ${todo.aside.tone === "warn" ? "text-warn" : "text-muted"}`}>{todo.aside.text}</p> : null}
                <p id={`todo-${todo.key}`} className={LIST_ROW_TITLE}>
                  {todo.rating ? (
                    <>
                      <RatingStars rating={todo.rating} label={`${todo.rating} 点`} />{" "}
                    </>
                  ) : null}
                  {todo.title}
                </p>
                {todo.detail ? <p className={LIST_ROW_DETAIL}>{todo.detail}</p> : null}
              </div>
              {todo.approval || todo.action ? (
                <div className="flex shrink-0 flex-wrap gap-2 max-md:ml-auto">
                  {todo.approval ? (
                    <button type="button" aria-describedby={`todo-${todo.key}`} onClick={() => setAsking(todo.approval)} className={consoleButtonClass("primary", "sm")}>
                      承認する
                    </button>
                  ) : null}
                  {todo.action ? (
                    <Link href={link(todo.action.href)} aria-describedby={`todo-${todo.key}`} className={consoleButtonClass(todo.action.primary ? "primary" : "secondary", "sm")}>
                      {todo.action.label}
                    </Link>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 pb-4 text-muted md:px-5">いま対応が必要なことはありません。</p>
      )}
      {asking ? <BookingDecisionDialog kind="approve" booking={asking.booking} onConfirm={() => approve(asking)} onClose={() => setAsking(null)} /> : null}
    </section>
  );
}
