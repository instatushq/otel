using Xunit;

namespace Instatus.Otel.Tests;

[CollectionDefinition(Name, DisableParallelization = true)]
public class SdkCollection
{
    public const string Name = "Global SDK state";
}
