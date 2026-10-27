// Stub LittleFS untuk uji di PC: API minimal yang dipakai offline_buffer.cpp, dipetakan ke folder
// sementara di sistem berkas host. Bukan emulasi flash; hanya semantik berkas.
#pragma once
#include <cstdio>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

class File {
 public:
  File() = default;
  File(const std::string& real, const std::string& name, const char* mode) : name_(name) {
    if (std::filesystem::is_directory(real)) {
      dir_ = true;
      for (auto& e : std::filesystem::directory_iterator(real)) entries_.push_back(e.path().string());
      return;
    }
    std::string m = mode[0] == 'a' ? "ab" : mode[0] == 'w' ? "wb" : "rb";
    if (m == "rb" && !std::filesystem::exists(real)) return;
    FILE* f = fopen(real.c_str(), m.c_str());
    if (f) f_ = std::shared_ptr<FILE>(f, [](FILE* p) { fclose(p); });
  }
  explicit operator bool() const { return f_ != nullptr || dir_; }
  size_t write(const uint8_t* b, size_t n) { return f_ ? fwrite(b, 1, n, f_.get()) : 0; }
  size_t read(uint8_t* b, size_t n) { return f_ ? fread(b, 1, n, f_.get()) : 0; }
  int available() {
    if (!f_) return 0;
    long p = ftell(f_.get()); fseek(f_.get(), 0, SEEK_END); long e = ftell(f_.get()); fseek(f_.get(), p, SEEK_SET);
    return (int)(e - p);
  }
  size_t position() { return f_ ? ftell(f_.get()) : 0; }
  bool seek(size_t p) { return f_ && fseek(f_.get(), (long)p, SEEK_SET) == 0; }
  size_t size() {
    if (!f_) return 0;
    long p = ftell(f_.get()); fseek(f_.get(), 0, SEEK_END); long e = ftell(f_.get()); fseek(f_.get(), p, SEEK_SET);
    return (size_t)e;
  }
  void close() { f_.reset(); dir_ = false; }
  bool isDirectory() const { return dir_; }
  const char* name() const { return name_.c_str(); }
  File openNextFile() {
    if (ei_ >= entries_.size()) return File();
    std::string p = entries_[ei_++];
    return File(p, std::filesystem::path(p).filename().string(), "r");
  }

 private:
  std::shared_ptr<FILE> f_;
  std::string name_;
  bool dir_ = false;
  std::vector<std::string> entries_;
  size_t ei_ = 0;
};

class LittleFSFS {
 public:
  std::string root = "/tmp/littlefs_host";
  bool begin(bool) { std::filesystem::create_directories(root); return true; }
  std::string real(const char* p) const { return root + p; }
  bool exists(const char* p) { return std::filesystem::exists(real(p)); }
  File open(const char* p, const char* mode = "r") { return File(real(p), p, mode); }
  bool remove(const char* p) { return std::filesystem::remove(real(p)); }
  bool rename(const char* a, const char* b) {
    std::error_code ec; std::filesystem::rename(real(a), real(b), ec); return !ec;
  }
  bool mkdir(const char* p) { return std::filesystem::create_directories(real(p)); }
};
extern LittleFSFS LittleFS;
