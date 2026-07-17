package main

import (
	"sync"
	"testing"
)

// Per-tenant admission control (RUNNER_TENANT_MAX). Proves the fairness primitive that keeps one
// tenant from monopolizing the shared runner's docker slots: tryAcquire caps a tenant's in-flight
// runs, release frees them, tenants are isolated, and the counter map doesn't leak.

func reset() { inflight = map[string]int{} }

func TestTryAcquireCapsPerTenant(t *testing.T) {
	tenantMax = 2
	reset()
	const A = "tenant-a"

	if !tryAcquire(A) || !tryAcquire(A) {
		t.Fatal("first two acquires under the cap should succeed")
	}
	if tryAcquire(A) {
		t.Fatal("third acquire at the cap must be refused")
	}
	release(A)
	if !tryAcquire(A) {
		t.Fatal("after a release a slot must free up")
	}
}

func TestTenantsAreIsolated(t *testing.T) {
	tenantMax = 1
	reset()
	const A, B = "tenant-a", "tenant-b"

	if !tryAcquire(A) {
		t.Fatal("A should get its one slot")
	}
	if tryAcquire(A) {
		t.Fatal("A is at its cap")
	}
	if !tryAcquire(B) {
		t.Fatal("B must be unaffected by A's cap")
	}
}

func TestReleaseCleansUpMap(t *testing.T) {
	tenantMax = 2
	reset()
	const A = "tenant-a"

	tryAcquire(A)
	tryAcquire(A)
	release(A)
	release(A)
	if _, present := inflight[A]; present {
		t.Fatalf("counter for a fully-released tenant should be deleted, got %d", inflight[A])
	}
}

func TestCapDisabledWhenZero(t *testing.T) {
	tenantMax = 0
	reset()
	const A = "tenant-a"

	for i := 0; i < 100; i++ {
		if !tryAcquire(A) {
			t.Fatalf("with tenantMax<=0 the cap is disabled; acquire %d should pass", i)
		}
	}
}

// The acquire/release pair must be race-free under concurrent handleJob goroutines.
func TestConcurrentAcquireRelease(t *testing.T) {
	tenantMax = 4
	reset()
	const A = "tenant-a"

	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if tryAcquire(A) {
				release(A)
			}
		}()
	}
	wg.Wait()
	if inflight[A] != 0 {
		t.Fatalf("every acquired slot should be released, residual %d", inflight[A])
	}
}
