using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace WebView2PrintHelper;

internal sealed class PrintRequest
{
    public string SourcePath { get; set; } = "";
    public string? PrinterName { get; set; }
    public int Copies { get; set; } = 1;
    public double? PageWidthMm { get; set; }
    public double? PageHeightMm { get; set; }
    public PrintMargins? MarginsMm { get; set; }
}

internal sealed class PrintMargins
{
    public double Top { get; set; }
    public double Right { get; set; }
    public double Bottom { get; set; }
    public double Left { get; set; }
}

internal static class Program
{
    private const int Success = 0;
    private const int UsageError = 2;
    private const int PrintError = 3;

    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        if (args.Length != 1)
        {
            Console.Error.WriteLine("Usage: WebView2PrintHelper.exe <request-json-path>");
            Environment.Exit(UsageError);
            return;
        }

        try
        {
            var raw = File.ReadAllText(args[0]);
            var request = JsonSerializer.Deserialize<PrintRequest>(
                raw,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true }
            );

            if (request is null || string.IsNullOrWhiteSpace(request.SourcePath))
            {
                throw new InvalidOperationException("Invalid print request.");
            }

            using var form = new HiddenPrintForm(request);
            Application.Run(form);
            Environment.Exit(form.ExitCode);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex);
            Environment.Exit(PrintError);
        }
    }

    private sealed class HiddenPrintForm : Form
    {
        private readonly PrintRequest _request;
        private readonly WebView2 _webView;

        public int ExitCode { get; private set; } = PrintError;

        public HiddenPrintForm(PrintRequest request)
        {
            _request = request;
            ShowInTaskbar = false;
            WindowState = FormWindowState.Minimized;
            FormBorderStyle = FormBorderStyle.FixedToolWindow;
            Opacity = 0;
            Width = 1;
            Height = 1;

            _webView = new WebView2
            {
                Dock = DockStyle.Fill,
                CreationProperties = new CoreWebView2CreationProperties()
            };
            Controls.Add(_webView);
        }

        protected override async void OnShown(EventArgs e)
        {
            base.OnShown(e);

            try
            {
                await _webView.EnsureCoreWebView2Async();
                _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;

                var source = Path.GetFullPath(_request.SourcePath);
                if (!File.Exists(source))
                {
                    throw new FileNotFoundException("Print source not found.", source);
                }

                await NavigateAsync(new Uri(source).AbsoluteUri);
                await WaitForRenderReadyAsync();
                await PrintAsync();

                ExitCode = Success;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex);
                ExitCode = PrintError;
            }
            finally
            {
                Close();
            }
        }

        private Task NavigateAsync(string uri)
        {
            var tcs = new TaskCompletionSource();

            void Handler(object? sender, CoreWebView2NavigationCompletedEventArgs args)
            {
                _webView.NavigationCompleted -= Handler;
                if (args.IsSuccess)
                {
                    tcs.TrySetResult();
                }
                else
                {
                    tcs.TrySetException(new InvalidOperationException($"Navigation failed: {args.WebErrorStatus}"));
                }
            }

            _webView.NavigationCompleted += Handler;
            _webView.CoreWebView2.Navigate(uri);
            return tcs.Task;
        }

        private async Task WaitForRenderReadyAsync()
        {
            await _webView.CoreWebView2.ExecuteScriptAsync(
                """
                Promise.all([
                  document.fonts ? document.fonts.ready : Promise.resolve(),
                  Promise.all(Array.from(document.images || []).map((img) => {
                    if (img.complete) return Promise.resolve();
                    return new Promise((resolve) => {
                      img.onload = resolve;
                      img.onerror = resolve;
                    });
                  }))
                ]).then(() => true)
                """
            );
        }

        private async Task PrintAsync()
        {
            var settings = _webView.CoreWebView2.Environment.CreatePrintSettings();
            settings.ShouldPrintBackgrounds = true;
            settings.ShouldPrintHeaderAndFooter = false;
            settings.Copies = Math.Max(1, _request.Copies);

            if (!string.IsNullOrWhiteSpace(_request.PrinterName))
            {
                settings.PrinterName = _request.PrinterName;
            }

            if (_request.PageWidthMm is > 0 && _request.PageHeightMm is > 0)
            {
                settings.PageWidth = MmToInches(_request.PageWidthMm.Value);
                settings.PageHeight = MmToInches(_request.PageHeightMm.Value);
            }

            if (_request.MarginsMm is { } margins)
            {
                settings.MarginTop = MmToInches(margins.Top);
                settings.MarginRight = MmToInches(margins.Right);
                settings.MarginBottom = MmToInches(margins.Bottom);
                settings.MarginLeft = MmToInches(margins.Left);
            }

            var status = await _webView.CoreWebView2.PrintAsync(settings);
            if (status != CoreWebView2PrintStatus.Succeeded)
            {
                throw new InvalidOperationException($"WebView2 print failed: {status}");
            }
        }

        private static double MmToInches(double mm) => mm / 25.4;
    }
}
