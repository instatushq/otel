using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Extensions.Logging;

namespace Instatus.Internal;

// An ILogger state with the error filters applied to its values and to its
// message, which is rendered again from the filtered values when one changed.
internal sealed class FilteredLogState : IReadOnlyList<KeyValuePair<string, object?>>
{
    private const string OriginalFormat = "{OriginalFormat}";

    private readonly List<KeyValuePair<string, object?>> values;
    private readonly string message;

    private FilteredLogState(List<KeyValuePair<string, object?>> values, string message)
    {
        this.values = values;
        this.message = message;
    }

    public static string Format(FilteredLogState state, Exception? _) => state.message;

    public KeyValuePair<string, object?> this[int index] => values[index];

    public int Count => values.Count;

    public IEnumerator<KeyValuePair<string, object?>> GetEnumerator() => values.GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

    public static FilteredLogState From(IEnumerable<KeyValuePair<string, object?>> state, Func<string> render)
    {
        var filtered = new List<KeyValuePair<string, object?>>();
        var changed = false;
        string? template = null;
        foreach (var (key, value) in state)
        {
            if (key == OriginalFormat)
            {
                template = value as string;
                filtered.Add(new(key, value));
                continue;
            }
            var scrubbed = Scrubber.ScrubLogValue(key, value);
            changed |= !Equals(scrubbed, value);
            filtered.Add(new(key, scrubbed));
        }
        var text = changed && template is not null ? Render(template, filtered) : render();
        return new FilteredLogState(filtered, Scrubber.ScrubText(text));
    }

    private static List<string> HoleNames(string template)
    {
        var names = new List<string>();
        var index = 0;
        while (index < template.Length)
        {
            var open = template.IndexOf('{', index);
            if (open < 0) break;
            if (open + 1 < template.Length && template[open + 1] == '{')
            {
                index = open + 2;
                continue;
            }
            var close = template.IndexOf('}', open);
            if (close < 0) break;
            var hole = template.AsSpan(open + 1, close - open - 1);
            var cut = hole.IndexOfAny(',', ':');
            names.Add((cut < 0 ? hole : hole[..cut]).ToString());
            index = close + 1;
        }
        return names;
    }

    // Logging's own call fills holes by position, while a [LoggerMessage]
    // state lists its values in the method's parameter order.
    private static object?[]? ArgumentsFor(List<string> names, List<KeyValuePair<string, object?>> values)
    {
        var inTemplateOrder = names.Count == values.Count &&
                              names.Select((name, index) => Matches(name, values[index].Key)).All(match => match);
        if (inTemplateOrder) return values.Select(entry => entry.Value).ToArray();
        var arguments = new object?[names.Count];
        for (var index = 0; index < names.Count; index++)
        {
            var match = values.FindIndex(entry => Matches(names[index], entry.Key));
            if (match < 0) return null;
            arguments[index] = values[match].Value;
        }
        return arguments;
    }

    private static bool Matches(string name, string key) => string.Equals(name, key, StringComparison.OrdinalIgnoreCase);

    // Without every value the filtered message can't be built, and the
    // original one could hold what was filtered, so the template stands in.
    private static string Render(string template, List<KeyValuePair<string, object?>> filtered)
    {
        var values = filtered.Where(entry => entry.Key != OriginalFormat).ToList();
        var arguments = ArgumentsFor(HoleNames(template), values);
        if (arguments is null) return template;
        try
        {
            var renderer = new Renderer();
            renderer.Log(LogLevel.Information, template, arguments);
            return renderer.Text ?? template;
        }
        catch (FormatException)
        {
            return template;
        }
    }

    // Renders a template the way Microsoft.Extensions.Logging does, through
    // the same formatter its LogInformation uses.
    private sealed class Renderer : ILogger
    {
        public string? Text { get; private set; }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            Text = formatter(state, exception);
    }
}
