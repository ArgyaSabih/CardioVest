// Stub minimal agar algoritma firmware (dsp, algo, ecg_codec) dapat dikompilasi & diuji di PC.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <math.h>
#include <string.h>
#include <string>
// tipe FreeRTOS minimal agar shared.h dapat dikompilasi di PC
typedef void* QueueHandle_t;
typedef void* SemaphoreHandle_t;
typedef void* TaskHandle_t;
#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
using std::min;
using std::max;
#define portMAX_DELAY 0xFFFFFFFFu
inline SemaphoreHandle_t xSemaphoreCreateMutex() { return (SemaphoreHandle_t)1; }
inline int xSemaphoreTake(SemaphoreHandle_t, unsigned) { return 1; }
inline int xSemaphoreGive(SemaphoreHandle_t) { return 1; }
inline unsigned long millis() { return 0; }
struct HostSerial {
  void printf(const char* fmt, ...) {
    va_list a; va_start(a, fmt); vfprintf(stderr, fmt, a); va_end(a);
  }
};
extern HostSerial Serial;
#ifndef NAN
#define NAN (0.0f / 0.0f)
#endif
