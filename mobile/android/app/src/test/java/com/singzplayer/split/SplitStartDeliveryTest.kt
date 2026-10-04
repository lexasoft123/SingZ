package com.singzplayer.split

import org.junit.Assert.*
import org.junit.Test

class SplitStartDeliveryTest {
  @Test fun missingReceiptRetriesOnlyOnce() {
    val delivery = SplitStartDelivery()
    val request = delivery.begin()
    assertTrue(delivery.takeRetry(request))
    assertFalse(delivery.takeRetry(request))
  }

  @Test fun receiptPreventsRestartingAQuicklyCompletedJob() {
    val delivery = SplitStartDelivery()
    val request = delivery.begin()
    delivery.acknowledge(request)
    assertFalse(delivery.takeRetry(request))
  }

  @Test fun cancellationInvalidatesTheQueuedRetry() {
    val delivery = SplitStartDelivery()
    val request = delivery.begin()
    delivery.cancel()
    assertFalse(delivery.takeRetry(request))
  }

  @Test fun oldReceiptAndTimerCannotAffectReplacement() {
    val delivery = SplitStartDelivery()
    val old = delivery.begin()
    val current = delivery.begin()
    delivery.acknowledge(old)
    assertFalse(delivery.takeRetry(old))
    assertTrue(delivery.takeRetry(current))
  }

  @Test fun oldTimerCannotReviveCancelledJobAfterAnotherStart() {
    val delivery = SplitStartDelivery()
    val old = delivery.begin()
    delivery.cancel()
    val current = delivery.begin()
    assertFalse(delivery.takeRetry(old))
    delivery.acknowledge(current)
    assertFalse(delivery.takeRetry(current))
  }
}
