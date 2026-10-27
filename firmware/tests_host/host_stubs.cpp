// Pengganti shared.cpp untuk uji di PC (tanpa FreeRTOS).
#include "shared.h"
#include <string.h>
volatile DevState g_state = ST_NORMAL;
uint64_t now_ms() { return 1790700000000ULL; }
const char* stateName(DevState s) { return s == ST_CRITICAL ? "CRITICAL" : s == ST_WARNING ? "WARNING" : "NORMAL"; }
