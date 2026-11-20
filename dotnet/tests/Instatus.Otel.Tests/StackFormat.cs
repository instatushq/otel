using System.Text.RegularExpressions;

namespace Instatus.Otel.Tests;

// The language detection and .NET frame pattern from the backend's
// packages/backend/src/modules/issues/helpers/stack-frames.ts, in order.
internal static class StackFormat
{
    private const RegexOptions Js = RegexOptions.ECMAScript | RegexOptions.Multiline;

    public static string Detect(string stack)
    {
        if (Regex.IsMatch(stack, @"Traceback \(most recent call last\)", Js) || Regex.IsMatch(stack, @"^\s*File "".*"", line \d+", Js))
            return "python";
        if (Regex.IsMatch(stack, @"^goroutine \d+ \[", Js) || Regex.IsMatch(stack, @"^\t.*\.go:\d+", Js)) return "go";
        if (Regex.IsMatch(stack, @"^\d+\t[^\t]+\t0x[0-9a-fA-F]+\t", Js)) return "native";
        if (Regex.IsMatch(stack, @"^#\d+ ", Js)) return "php";
        if (Regex.IsMatch(stack, @":\d+:in [`']", Js)) return "ruby";
        if (Regex.IsMatch(stack, @"^\s*at [\w$./<>-]+\((?:[\w$-]+\.(?:java|kt|scala|groovy|clj):\d+|Native Method|Unknown Source)\)", Js))
            return "java";
        if (Regex.IsMatch(stack, @":\d+:\d+\)?\s*$", Js) || Regex.IsMatch(stack, @"^[^\s@]*@\S+:\d+", Js)) return "javascript";
        if (Regex.IsMatch(stack, @"^\s*at [\w.`<>[\],+]+\(.*\)", Js)) return "dotnet";
        return "javascript";
    }

    public static readonly Regex DotnetFrame = new(@"^\s*at (.+?)(?: in (.+):line (\d+))?\s*$", RegexOptions.ECMAScript);
}
