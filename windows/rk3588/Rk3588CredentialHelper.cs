using System;
using System.IO;
using System.Net;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;

namespace CodexProxy.Rk3588
{
    [DataContract]
    internal sealed class CredentialEnvelope
    {
        [DataMember(Name = "schema_version")]
        public int SchemaVersion { get; set; }

        [DataMember(Name = "protection")]
        public string Protection { get; set; }

        [DataMember(Name = "ciphertext")]
        public string Ciphertext { get; set; }
    }

    [DataContract]
    internal sealed class ModelItem
    {
    }

    [DataContract]
    internal sealed class ModelsEnvelope
    {
        [DataMember(Name = "data")]
        public ModelItem[] Data { get; set; }
    }

    internal static class CredentialHelper
    {
        private const string CredentialFileName = "credential.dpapi.json";
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes(
            "codex-proxy-rk3588-windows-client-v1"
        );

        private static bool IsValidCredential(string value)
        {
            if (String.IsNullOrEmpty(value))
            {
                return false;
            }

            int byteCount = Encoding.UTF8.GetByteCount(value);
            if (byteCount < 32 || byteCount > 4096)
            {
                return false;
            }

            foreach (char character in value)
            {
                if (character < 0x21 || character > 0x7e)
                {
                    return false;
                }
            }
            return true;
        }

        private static CredentialEnvelope ReadEnvelope(string stateDirectory)
        {
            string filePath = Path.Combine(
                Path.GetFullPath(stateDirectory),
                CredentialFileName
            );
            FileInfo file = new FileInfo(filePath);
            if (!file.Exists || file.Length <= 0 || file.Length > 65536)
            {
                throw new InvalidDataException();
            }

            using (FileStream stream = new FileStream(
                file.FullName,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read
            ))
            {
                DataContractJsonSerializer serializer =
                    new DataContractJsonSerializer(typeof(CredentialEnvelope));
                CredentialEnvelope envelope =
                    serializer.ReadObject(stream) as CredentialEnvelope;
                if (
                    envelope == null ||
                    envelope.SchemaVersion != 1 ||
                    envelope.Protection != "Windows DPAPI CurrentUser" ||
                    String.IsNullOrWhiteSpace(envelope.Ciphertext)
                )
                {
                    throw new InvalidDataException();
                }
                return envelope;
            }
        }

        private static int CheckModelsEndpoint(string url, string credential)
        {
            Uri endpoint;
            if (
                !Uri.TryCreate(url, UriKind.Absolute, out endpoint) ||
                endpoint.Scheme != Uri.UriSchemeHttps ||
                !String.IsNullOrEmpty(endpoint.UserInfo) ||
                !String.IsNullOrEmpty(endpoint.Query) ||
                !String.IsNullOrEmpty(endpoint.Fragment) ||
                !endpoint.AbsolutePath.EndsWith(
                    "/v1/models",
                    StringComparison.Ordinal
                )
            )
            {
                throw new ArgumentException();
            }

            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(endpoint);
            request.Method = "GET";
            request.Accept = "application/json";
            request.AllowAutoRedirect = false;
            request.Timeout = 20000;
            request.ReadWriteTimeout = 20000;
            request.Headers[HttpRequestHeader.Authorization] =
                "Bearer " + credential;

            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                if (response.StatusCode != HttpStatusCode.OK)
                {
                    throw new InvalidDataException();
                }
                using (Stream source = response.GetResponseStream())
                using (MemoryStream bounded = new MemoryStream())
                {
                    byte[] chunk = new byte[8192];
                    int total = 0;
                    int read;
                    while ((read = source.Read(chunk, 0, chunk.Length)) > 0)
                    {
                        total += read;
                        if (total > 4 * 1024 * 1024)
                        {
                            throw new InvalidDataException();
                        }
                        bounded.Write(chunk, 0, read);
                    }
                    bounded.Position = 0;
                    DataContractJsonSerializer serializer =
                        new DataContractJsonSerializer(typeof(ModelsEnvelope));
                    ModelsEnvelope models =
                        serializer.ReadObject(bounded) as ModelsEnvelope;
                    if (models == null || models.Data == null)
                    {
                        throw new InvalidDataException();
                    }
                    Console.Out.Write(
                        models.Data.Length.ToString(
                            System.Globalization.CultureInfo.InvariantCulture
                        )
                    );
                    return 0;
                }
            }
        }

        public static int Main(string[] arguments)
        {
            byte[] protectedBytes = null;
            byte[] plainBytes = null;
            string credential = null;
            try
            {
                bool tokenMode =
                    arguments.Length == 2 &&
                    arguments[0] == "--state-dir";
                bool checkMode =
                    arguments.Length == 3 &&
                    arguments[0] == "--state-dir" &&
                    arguments[2] == "--check";
                bool modelsMode =
                    arguments.Length == 4 &&
                    arguments[0] == "--state-dir" &&
                    arguments[2] == "--models-url";
                if (!tokenMode && !checkMode && !modelsMode)
                {
                    throw new ArgumentException();
                }

                CredentialEnvelope envelope = ReadEnvelope(arguments[1]);
                protectedBytes = Convert.FromBase64String(envelope.Ciphertext);
                plainBytes = ProtectedData.Unprotect(
                    protectedBytes,
                    Entropy,
                    DataProtectionScope.CurrentUser
                );
                credential = new UTF8Encoding(false, true).GetString(plainBytes);
                if (!IsValidCredential(credential))
                {
                    throw new InvalidDataException();
                }

                if (modelsMode)
                {
                    return CheckModelsEndpoint(arguments[3], credential);
                }
                if (tokenMode)
                {
                    Console.Out.Write(credential);
                }
                return 0;
            }
            catch
            {
                Console.Error.WriteLine(
                    "[rk3588-auth] credential unavailable or invalid"
                );
                return 1;
            }
            finally
            {
                credential = null;
                if (protectedBytes != null)
                {
                    Array.Clear(protectedBytes, 0, protectedBytes.Length);
                }
                if (plainBytes != null)
                {
                    Array.Clear(plainBytes, 0, plainBytes.Length);
                }
            }
        }
    }
}
