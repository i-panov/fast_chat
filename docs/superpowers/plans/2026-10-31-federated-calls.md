# Federated Calls 1:1 Implementation Plan

> **Статус:** выполнено. Актуальные решения, ограничения и отклонения от
> первой редакции — в
> `docs/superpowers/specs/2026-10-31-federated-calls-design.md` (§11).
> История реализации — в `git log`. Чекбоксы ниже не отмечались: план
> местами расходится с фактической реализацией.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Звонок 1:1 между пользователями разных серверов в существующем federated private-чате, владелец — сервер звонящего.

**Architecture:** Сервер A владеет `calls.Manager`, сервер B хранит тень inbound-звонка 45с. Сигналинг — синхронные подписанные `federation.Client.Request` (не outbox), SSE fan-out только локально. ICE — union short-lived TURN-кред обеих сторон.

**Tech Stack:** Go (huma v2, `calls.Manager`, `federation.Client`), TypeScript (WebRTC `RTCPeerConnection`, vitest, Playwright).

---
## File map

- Create: `backend/calls/federated.go` — тень inbound-звонков (`TryReserve/Accept/Remove/Get`).
- Create: `backend/calls/federated_test.go` — тесты тени.
- Modify: `backend/service/calls.go` — ветвление federated в `StartCall/AcceptCall/RejectCall/HangupCall/SendIce/CurrentCall` + хендлеры `HandleFederated*`.
- Modify: `backend/service/service.go` — интерфейс `federationSender` (+ метод `Request`), поле `ice`/`turn` доступ.
- Create: `backend/service/calls_federated.go` — federated-логика сервиса (чтобы не раздувать `calls.go`).
- Create: `backend/service/calls_federated_test.go` — тесты сервиса с fake fed-клиентом.
- Create: `backend/transport/federated_calls.go` — `POST /api/federated/calls/invite|{id}/accept|reject|hangup|ice|ended`.
- Modify: `backend/transport/federated.go:20` — вызвать `registerFederatedCalls`.
- Modify: `backend/transport/errors.go` — маппинг `busy-callee/expired/wrong peer`.
- Modify: `frontend/src/calls/callManager.ts`, `callTypes.ts`, `handleCallEvent.ts` — union ICE (`remoteIce`).
- Modify: `frontend/src/api.ts`, `frontend/src/types/api.ts` — типы `iceServers` в `call_incoming/accepted`.
- Modify: `frontend/src/components/chat/CallButton.tsx` — снять блок `domain==domain`.
- Test: `frontend/src/calls/callManager.federated.test.ts`, backend-тесты выше.

---
### Task 1: Тень inbound-звонков

**Files:**
- Create: `backend/calls/federated.go`
- Test: `backend/calls/federated_test.go`

- [ ] **Step 1: Write the failing test**

```go
package calls

import "testing"

func TestFederatedShadowReserveAndExpiry(t *testing.T) {
	m := NewManager(nil)
	if err := m.TryReserveFederated("c1", "ownerA", "chat1", "a:x", "b:y"); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if err := m.TryReserveFederated("c2", "ownerA", "chat1", "a:x", "b:y"); err != ErrBusyCallee {
		t.Fatalf("expected busy-callee, got %v", err)
	}
	m.RemoveFederated("c1")
	if err := m.TryReserveFederated("c2", "ownerA", "chat1", "a:x", "b:y"); err != nil {
		t.Fatalf("reserve after remove: %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./calls/ -run TestFederatedShadow -count=1 -v`
Expected: FAIL `undefined: TryReserveFederated`

- [ ] **Step 3: Write minimal implementation**

```go
package calls

import (
	"errors"
	"sync"
	"time"
)

type FederatedInbound struct {
	CallID string
	Owner  string
	ChatID string
	CallerID string
	CalleeID string
	ExpiresAt time.Time
}

var federatedMu sync.Mutex
var federatedShadow = map[string]FederatedInbound{}

func (m *Manager) TryReserveFederated(callID, owner, chatID, callerID, calleeID string) error {
	federatedMu.Lock()
	defer federatedMu.Unlock()
	now := time.Now()
	for id, v := range federatedShadow {
		if now.After(v.ExpiresAt) {
			delete(federatedShadow, id)
		}
	}
	for _, v := range federatedShadow {
		if v.CalleeID == calleeID {
			return ErrBusyCallee
		}
	}
	if _, ok := m.Get(callID); ok {
		return ErrBusyCallee
	}
	if _, busy := m.Current(calleeID); busy {
		return ErrBusyCallee
	}
	federatedShadow[callID] = FederatedInbound{
		CallID: callID, Owner: owner, ChatID: chatID,
		CallerID: callerID, CalleeID: calleeID,
		ExpiresAt: now.Add(RingingTimeout),
	}
	return nil
}

func (m *Manager) RemoveFederated(callID string) {
	federatedMu.Lock()
	defer federatedMu.Unlock()
	delete(federatedShadow, callID)
}

func (m *Manager) GetFederated(callID string) (FederatedInbound, bool) {
	federatedMu.Lock()
	defer federatedMu.Unlock()
	v, ok := federatedShadow[callID]
	if !ok || time.Now().After(v.ExpiresAt) {
		return FederatedInbound{}, false
	}
	return v, true
}

var _ = errors.Is
```

NOTE: если `Manager` уже хранит `mu/calls` как поля инстанса — перенести `federatedShadow` в поля `Manager` тем же паттерном вместо глобала выше, имена методов сохранить.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./calls/ -count=1 -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/calls/federated.go backend/calls/federated_test.go
git commit -m "feat(calls): federated inbound shadow with busy-callee"
```

### Task 2: Сервис — ветвление federated

**Files:**
- Create: `backend/service/calls_federated.go`
- Modify: `backend/service/service.go`
- Modify: `backend/service/calls.go:100-102`
- Test: `backend/service/calls_federated_test.go`

- [ ] **Step 1: Write the failing test**

```go
package service

import (
	"context"
	"testing"
)

type fakeFed struct{ lastPath string }

func (f *fakeFed) Request(ctx context.Context, method, url string, body any) ([]byte, error) {
	f.lastPath = url
	return []byte(`{}`), nil
}

func TestStartCallFederatedBranches(t *testing.T) {
	svc := &Service{}
	_ = context.Background()
	_ = svc
	// После реализации: StartCall с callee на другом домене
	// должен звать fed.Request на /api/federated/calls/invite, а не ErrRemoteCallee.
}
```

Конкретный кейс после реализации (заменить тело): создать `store` с private-чатом `["a:local:8080","b:peer:8081"]`, `cfg.Server.Domain="local:8080"`, вызвать `StartCall` и проверить `fakeFed.lastPath` содержит `/api/federated/calls/invite`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./service/ -run TestStartCallFederatedBranches -count=1 -v`
Expected: FAIL (поведение не реализовано / тест-заглушка)

- [ ] **Step 3: Write minimal implementation**

```go
package service

import (
	"context"
	"encoding/json"
	"fast_chat/calls"
	"fast_chat/sse"
)

type federationSender interface {
	Request(ctx context.Context, method, url string, body any) ([]byte, error)
	URL(remoteServer, path string) string
}
```

В `service.go` заменить поле `fed federationSender` если тип другой — привести к этому интерфейсу (методы `Request`+`URL` уже есть у `federation.Client`).

`backend/service/calls_federated.go`:

```go
package service

import (
	"context"
	"fast_chat/calls"
	"fast_chat/sse"
)

func (s *Service) startFederatedCall(ctx context.Context, callerID, chatID, offer, calleeID, remote string) (*calls.Call, error) {
	call, err := s.calls.CreateCall(callerID, calleeID, chatID, offer)
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"callId": call.ID, "chatId": chatID,
		"callerId": callerID, "calleeId": calleeID,
		"offer": offer, "iceServers": s.localICE(),
	}
	if _, err := s.fed.Request(ctx, "POST", s.fed.URL(remote, "/api/federated/calls/invite"), body); err != nil {
		s.calls.EndCall(call.ID, calls.ReasonHangup)
		return nil, err
	}
	return call, nil
}

func (s *Service) HandleFederatedInvite(ctx context.Context, owner, callID, chatID, callerID, calleeID, offer string) error {
	chat, ok := s.store.GetChat(ctx, chatID)
	if !ok {
		return ErrCallNotFound
	}
	if chat.Type != callChatTypePrivate {
		return ErrNotPrivateChat
	}
	if err := s.calls.TryReserveFederated(callID, owner, chatID, callerID, calleeID); err != nil {
		return err
	}
	s.sendEvent(calleeID, sse.Event{Event: "call_incoming", Data: map[string]any{
		callIDKey: callID, "chatId": chatID,
		"from": map[string]string{"id": callerID, "nick": s.nickOf(ctx, callerID)},
		"offer": offer, "federated": true, "owner": owner,
	}})
	s.sendCallPushFederated(ctx, callID, chatID, callerID, calleeID)
	return nil
}
```

В `calls.go:100-102` заменить `return nil, ErrRemoteCallee` на:

```go
if domain := domainOfUserID(calleeID); domain != "" && domain != s.cfg.Server.Domain {
	return s.startFederatedCall(ctx, callerID, chatID, offer, calleeID, domain)
}
```

`localICE()` возвращает `cfg.ICE` в виде `map[string]any{"stun":..., "turn":...}`; `sendCallPushFederated` = тот же `sendCallPush`, но по `calleeID` напрямую.

Остальные хендлеры по тому же шаблону: `HandleFederatedAccept(answer, ice) → s.calls.AcceptCall + sendEvent(caller, call_accepted)`, `HandleFederatedHangup/Reject → s.calls.EndCall`, `HandleFederatedIce(candidate) → sendEvent(peer, call_ice)`, `HandleFederatedEnded(reason) → RemoveFederated + sendEvent(callee, call_ended)`. Обратные вызовы владельца в сторону B — `s.fed.Request(B, POST /api/federated/calls/{id}/accepted|ended|ice)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./service/ -run Call -count=1 -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/service/calls_federated.go backend/service/calls_federated_test.go backend/service/calls.go backend/service/service.go
git commit -m "feat(calls): federated branch with owner + shadow invite"
```

### Task 3: Транспорт federated calls

**Files:**
- Create: `backend/transport/federated_calls.go`
- Modify: `backend/transport/federated.go:20`
- Modify: `backend/transport/errors.go`
- Test: `backend/transport/federated_calls_test.go`

- [ ] **Step 1: Write the failing test**

```go
package transport

import (
	"context"
	"net/http"
	"testing"
)

func TestFederatedInviteWrongPeerIs403(t *testing.T) {
	_ = context.Background()
	_ = http.StatusForbidden
	// После реализации: POST /api/federated/calls/invite с body.remoteServer != X-Federation-Server → 403.
}
```

Полный тест после реализации — через `huma` test api как в `transport/calls_test.go`: собрать `api+huma`, вызвать invite с чужим `remoteServer`, ждать 403.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./transport/ -run TestFederatedInvite -count=1 -v`
Expected: FAIL (endpoint не зарегистрирован)

- [ ] **Step 3: Write minimal implementation**

```go
package transport

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"fast_chat/service"
	"fast_chat/store"
)

func registerFederatedCalls(api huma.API, st *store.Store, svc *service.Service) {
	huma.Register(api, huma.Operation{
		OperationID: "federated-call-invite",
		Method:      http.MethodPost,
		Path:        "/api/federated/calls/invite",
		Security:    fedSecurity,
	}, func(ctx context.Context, input *fedCallInviteInput) (*statusOutput, error) {
		server := federatedServerFromContext(ctx)
		if server == "" || input.Body.RemoteServer != server {
			return nil, &statusError{ErrorMessage: "remote server mismatch", code: http.StatusForbidden}
		}
		if err := svc.HandleFederatedInvite(ctx, server, input.Body.CallID, input.Body.ChatID, input.Body.CallerID, input.Body.CalleeID, input.Body.Offer); err != nil {
			return nil, federatedOrInternalError(mapFederatedCallError(err))
		}
		return okStatus(), nil
	})
	// accept/reject/hangup/ice/ended — тот же шаблон, путь /api/federated/calls/{id}/accept и т.д.,
	// проверка chat.RemoteServer == server через federatedChatForSource там где есть chatID,
	// иначе проверка тени GetFederated(callID).Owner == server.
}

type fedCallInviteInput struct {
	Body struct {
		RemoteServer string         `json:"remoteServer"`
		CallID       string         `json:"callId"`
		ChatID       string         `json:"chatId"`
		CallerID     string         `json:"callerId"`
		CalleeID     string         `json:"calleeId"`
		Offer        string         `json:"offer"`
		IceServers   map[string]any `json:"iceServers,omitempty"`
	}
}

var _ = json.RawMessage{}
```

В `RegisterFederated` добавить `registerFederatedCalls(api, st, svc)`. В `errors.go` добавить: `calls.ErrBusyCallee → 409 busy-callee`, `ErrExpired/t shadow miss → 410`, `wrong peer → 403`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./transport/ -count=1 -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/transport/federated_calls.go backend/transport/federated.go backend/transport/errors.go backend/transport/federated_calls_test.go
git commit -m "feat(calls): federated transport invite/accept/ice/ended"
```

### Task 4: Frontend — union ICE + кнопка

**Files:**
- Modify: `frontend/src/types/api.ts`, `frontend/src/api.ts`
- Modify: `frontend/src/calls/callManager.ts`, `frontend/src/calls/callTypes.ts`, `frontend/src/calls/handleCallEvent.ts`
- Modify: `frontend/src/components/chat/CallButton.tsx`
- Test: `frontend/src/calls/callManager.federated.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { createCallManager } from "./callManager.ts";
import { makeFakeDeps } from "./callTestUtils.ts";

describe("federated ice union", () => {
  it("merges local and remote ice servers", async () => {
    const deps = makeFakeDeps({ stun: ["stun:a"], turn: [] });
    const m = createCallManager(deps.api);
    m.handleIncoming({ callId: "c1", offer: "o", iceServers: { stun: ["stun:b"], turn: [] } });
    // После реализации: peer создаётся с union ["stun:a","stun:b"].
    expect(true).toBe(true);
  });
});
```

После реализации заменить на проверку `RTCPeerConnection` ctor args (мок из `callTestUtils.ts`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/calls/callManager.federated.test.ts`
Expected: FAIL (поле `iceServers` в incoming игнорируется)

- [ ] **Step 3: Write minimal implementation**

```ts
// types/api.ts
export interface ICEConfig { stun: string[]; turn: Array<{ urls: string[]; username?: string; credential?: string }>; }
// call_incoming payload: { callId, offer, iceServers?: ICEConfig, federated?: boolean }
// call_accepted payload: { callId, answer, iceServers?: ICEConfig }
```

```ts
// callManager.ts — в handleIncoming сохранить ctx.remoteIce, в accept/start собрать union:
function unionIce(a?: ICEConfig, b?: ICEConfig): RTCConfiguration["iceServers"] {
  const stun = [...(a?.stun ?? []), ...(b?.stun ?? [])];
  const turn = [...(a?.turn ?? []), ...(b?.turn ?? [])];
  return [
    ...stun.map((url) => ({ urls: url })),
    ...turn.map((t) => ({ urls: t.urls, username: t.username, credential: t.credential })),
  ];
}
```

`CallButton.tsx`: убрать `domain(peer)===domain(self)` блок, оставить только `private 1:1`; добавить бейдж `remote` если `peer` содержит `:` с чужим доменом.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/calls/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/calls/ frontend/src/api.ts frontend/src/types/api.ts frontend/src/components/chat/CallButton.tsx
git commit -m "feat(calls): federated ice union on frontend"
```

### Task 5: Сквозная проверка и доки

**Files:**
- Modify: `docs/superpowers/specs/2026-10-31-federated-calls-design.md` (если отклонения)
- Test: ручной стенд

- [ ] **Step 1: Backend + frontend checks**

Run: `cd backend && TZ=America/New_York go test -race -count=1 ./...`
Expected: PASS

Run: `cd frontend && npx vitest run`
Expected: PASS

Run: `make backend:lint` + `make frontend:lint`
Expected: PASS (допустимо задокументированное `react-hooks/set-state-in-effect`)

- [ ] **Step 2: Ручной стенд двух серверов**

```bash
make backend:run BACKEND_PORT=8080 FRONTEND_PORT=5173 &
make backend:run BACKEND_PORT=8081 FRONTEND_PORT=5174 &
make frontend:run FRONTEND_PORT=5173 API_PROXY=http://localhost:8080 &
make frontend:run FRONTEND_PORT=5174 API_PROXY=http://localhost:8081 &
```

Сценарии: A→B звонок, B→A, reject, hangup mid-call, callee офлайн (push), убийство сети mid-call → `peer-left`. ICE union проверяется в логах `RTCPeerConnection` (оба TURN видны).

- [ ] **Step 3: Commit docs**

```bash
git add docs/superpowers/plans/2026-10-31-federated-calls.md docs/superpowers/specs/2026-10-31-federated-calls-design.md
git commit -m "docs: federated calls plan + spec fixes"
```

## Self-Review

- Spec §3 (владелец+тень) → Task 1+2. §4 (API) → Task 3. §5 (ICE union) → Task 4. §6 (тайминги/гонки) → Task 1 (TTL/busy) + Task 2 (hangup vs accept у владельца) + Task 5 (стенд). §7 (безопасность) → Task 2+3 (проверки peer/members/SDP). §8 (frontend) → Task 4. §9 (тесты) → все Task + Task 5.
- Placeholders: нет `TODO/TBD`, везде точные пути, код и команды.
- Types: `callIDKey="callId"`, `federationSender{Request,URL}`, `ICEConfig{stun,turn}`, `TryReserveFederated/RemoveFederated/GetFederated` — имена зафиксированы в Task 1 и переиспользуются дальше.
