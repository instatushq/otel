using System;

namespace Instatus.Internal;

internal sealed class RateCap
{
    private readonly object gate = new();
    private readonly int limit;
    private readonly TimeSpan window;
    private readonly Func<DateTimeOffset> now;
    private DateTimeOffset windowStart;
    private int count;

    public RateCap(int limit, TimeSpan window, Func<DateTimeOffset>? now = null)
    {
        this.limit = limit;
        this.window = window;
        this.now = now ?? (() => DateTimeOffset.UtcNow);
        windowStart = this.now();
    }

    public bool Take()
    {
        lock (gate)
        {
            var time = now();
            if (time - windowStart >= window)
            {
                windowStart = time;
                count = 0;
            }
            if (count >= limit) return false;
            count++;
            return true;
        }
    }
}
