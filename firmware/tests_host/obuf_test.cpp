// Uji offline_buffer.cpp di PC dengan stub LittleFS (dipanggil oleh test_firmware_algos.py).
#include <cassert>
#include <cstdio>
#include <filesystem>
#include <vector>
#include "offline_buffer.h"
#include "LittleFS.h"

LittleFSFS LittleFS;
HostSerial Serial;

static std::vector<std::vector<uint8_t>> got;
static int fail_after = -1;
static bool sender(BufKind k, const uint8_t* d, uint16_t n) {
  if (fail_after == 0) return false;
  if (fail_after > 0) fail_after--;
  std::vector<uint8_t> v(d, d + n);
  v.insert(v.begin(), (uint8_t)k);
  got.push_back(v);
  return true;
}
static std::vector<uint8_t> msg(int i, int len) {
  std::vector<uint8_t> v(len);
  for (int j = 0; j < len; ++j) v[j] = (uint8_t)(i * 7 + j);
  return v;
}
static long long bytes_written_to(const char* dir) {
  long long t = 0;
  for (auto& e : std::filesystem::directory_iterator(dir)) t += std::filesystem::file_size(e.path());
  return t;
}

int main(int argc, char** argv) {
  LittleFS.root = argc > 1 ? argv[1] : "/tmp/littlefs_host";
  std::filesystem::remove_all(LittleFS.root);
  assert(obuf_begin());

  // 1) urutan FIFO lintas segmen + perangkat restart di tengah
  const int N = 300, L = 900;                       // ~271 kB, melewati banyak segmen 16 kB
  for (int i = 0; i < N; ++i) { auto m = msg(i, L); assert(obuf_push(i % 3 ? BUF_VITAL : BUF_ECG, m.data(), L)); }
  assert(obuf_size() == (size_t)N * (L + 3));
  assert(obuf_flush(sender, 50) == 50);
  obuf_begin();                                     // "reboot": posisi kepala dipulihkan dari /ob/head
  assert(obuf_size() == (size_t)(N - 50) * (L + 3));
  // 2) pengirim gagal di tengah: sisa tidak hilang dan tidak terduplikasi
  fail_after = 7;
  assert(obuf_flush(sender, 50) == 7);
  fail_after = -1;
  while (obuf_flush(sender, 40) > 0) {}
  assert(obuf_size() == 0);
  assert(got.size() == (size_t)N);
  for (int i = 0; i < N; ++i) {
    auto m = msg(i, L);
    assert(got[i][0] == (i % 3 ? BUF_VITAL : BUF_ECG));
    assert(std::equal(m.begin(), m.end(), got[i].begin() + 1));
  }
  // 3) antrean kosong -> semua segmen terhapus, lalu bisa dipakai lagi
  assert(bytes_written_to((LittleFS.root + "/ob").c_str()) <= 8);   // tinggal berkas head
  auto m = msg(1, 10);
  assert(obuf_push(BUF_EVENT, m.data(), 10) && obuf_size() == 13);
  got.clear();
  assert(obuf_flush(sender, 10) == 1 && got[0][0] == BUF_EVENT);
  // 4) kapasitas penuh: pesan baru ditolak, yang lama tetap
  obuf_clear();
  size_t cap = (size_t)OFFLINE_BUFFER_MAX_KB * 1024;
  int accepted = 0;
  for (int i = 0; i < 2000; ++i) { auto x = msg(i, 1000); if (obuf_push(BUF_ECG, x.data(), 1000)) accepted++; }
  assert(obuf_size() <= cap && accepted == (int)(cap / 1003));
  // 5) migrasi antrean berkas tunggal versi lama
  obuf_clear();
  FILE* f = fopen((LittleFS.root + "/obuf.bin").c_str(), "wb");
  uint8_t h[3] = {BUF_VITAL, 0, 4}, d[4] = {1, 2, 3, 4};
  fwrite(h, 1, 3, f); fwrite(d, 1, 4, f); fclose(f);
  obuf_begin();
  assert(obuf_size() == 7);
  got.clear();
  assert(obuf_flush(sender, 5) == 1 && got[0][4] == 4);
  printf("OBUF OK %d pesan, %d segmen maks\n", N, (int)((N * (L + 3)) / OBUF_SEGMENT_BYTES + 1));
  return 0;
}
