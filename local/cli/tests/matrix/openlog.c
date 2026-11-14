/* Test-only: records every path the process tries to open, whether or not the file exists, one per line, to the file
 * named by UNSTALE_TEST_OPEN_LOG. Loaded into the client by the environment matrix (DYLD_INSERT_LIBRARIES on macOS,
 * LD_PRELOAD on Linux), so a read of any file outside the allowed places is seen, not only of files planted as
 * sentinels. It changes nothing the process does. */
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifdef __APPLE__
#define INTERPOSE(replacement, replacee)                                                                             \
    __attribute__((used)) static struct {                                                                            \
        const void *r;                                                                                               \
        const void *e;                                                                                               \
    } interpose_##replacee __attribute__((section("__DATA,__interpose"))) = {(const void *)&replacement,              \
                                                                               (const void *)&replacee};
#define REAL_OPEN open
#define REAL_OPENAT openat
#else
#include <dlfcn.h>
static int (*real_open)(const char *, int, ...);
static int (*real_openat)(int, const char *, int, ...);
static int REAL_OPEN(const char *p, int f, mode_t m) {
    if (!real_open) real_open = (int (*)(const char *, int, ...))dlsym(RTLD_NEXT, "open");
    return real_open(p, f, m);
}
static int REAL_OPENAT(int d, const char *p, int f, mode_t m) {
    if (!real_openat) real_openat = (int (*)(int, const char *, int, ...))dlsym(RTLD_NEXT, "openat");
    return real_openat(d, p, f, m);
}
#endif

static int log_fd = -2;

#ifndef __APPLE__
extern char *program_invocation_short_name;
#endif

/* Only the client's own opens: not the shells, `git` or the fake `codex` it may start. */
static int is_client(void) {
#ifdef __APPLE__
    const char *name = getprogname();
#else
    const char *name = program_invocation_short_name;
#endif
    return name && strcmp(name, "unstale") == 0;
}

static void note(int dirfd, const char *path) {
    if (!path) return;
    if (log_fd == -2) {
        const char *f = getenv("UNSTALE_TEST_OPEN_LOG");
        log_fd = (f && is_client()) ? REAL_OPEN(f, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600) : -1;
    }
    if (log_fd < 0) return;
    char base[2048] = "";
    if (path[0] != '/') {
        if (dirfd == AT_FDCWD) {
            if (!getcwd(base, sizeof base)) base[0] = 0;
        } else {
#ifdef __APPLE__
            if (fcntl(dirfd, F_GETPATH, base) < 0) base[0] = 0;
#else
            char link[64];
            snprintf(link, sizeof link, "/proc/self/fd/%d", dirfd);
            ssize_t k = readlink(link, base, sizeof base - 1);
            base[k > 0 ? k : 0] = 0;
#endif
        }
    }
    char line[4200];
    int n = base[0] ? snprintf(line, sizeof line, "%s/%s\n", base, path) : snprintf(line, sizeof line, "%s\n", path);
    if (n > 0 && n < (int)sizeof line) {
        ssize_t w = write(log_fd, line, (size_t)n);
        (void)w;
    }
}

static mode_t mode_of(int flags, va_list a) {
    return (flags & O_CREAT) ? (mode_t)va_arg(a, int) : 0;
}

#ifdef __APPLE__
static int logged_open(const char *p, int flags, ...) {
    va_list a;
    va_start(a, flags);
    mode_t m = mode_of(flags, a);
    va_end(a);
    note(AT_FDCWD, p);
    return open(p, flags, m);
}
static int logged_openat(int d, const char *p, int flags, ...) {
    va_list a;
    va_start(a, flags);
    mode_t m = mode_of(flags, a);
    va_end(a);
    note(d, p);
    return openat(d, p, flags, m);
}
INTERPOSE(logged_open, open)
INTERPOSE(logged_openat, openat)
#else
int open(const char *p, int flags, ...) {
    va_list a;
    va_start(a, flags);
    mode_t m = mode_of(flags, a);
    va_end(a);
    note(AT_FDCWD, p);
    return REAL_OPEN(p, flags, m);
}
int open64(const char *p, int flags, ...) {
    va_list a;
    va_start(a, flags);
    mode_t m = mode_of(flags, a);
    va_end(a);
    note(AT_FDCWD, p);
    return REAL_OPEN(p, flags, m);
}
int openat(int d, const char *p, int flags, ...) {
    va_list a;
    va_start(a, flags);
    mode_t m = mode_of(flags, a);
    va_end(a);
    note(d, p);
    return REAL_OPENAT(d, p, flags, m);
}
int openat64(int d, const char *p, int flags, ...) {
    va_list a;
    va_start(a, flags);
    mode_t m = mode_of(flags, a);
    va_end(a);
    note(d, p);
    return REAL_OPENAT(d, p, flags, m);
}
#endif
