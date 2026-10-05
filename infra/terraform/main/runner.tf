# A benchmark runner (HLD 13.3): a separate, small, fixed-performance machine in the host's
# region that runs the public harnesses against Kestrel's public endpoint (and against hosted
# vendors), as a customer in us-east-1 would. Off by default; create it for a run and destroy it
# after:  bin/tf main apply -var enable_runner=true  ...  bin/tf main apply
#
# It has no inbound rules (unless runner_proxy_port is set, below), and the host's role (Systems
# Manager only), so `bin/host` reaches it the same way: KESTREL_TARGET=runner bin/host run -- ...

resource "aws_security_group" "runner" {
  count       = var.enable_runner ? 1 : 0
  name        = "kestrel-runner"
  description = "Kestrel benchmark runner: outbound only."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "kestrel-runner" }
}

resource "aws_vpc_security_group_egress_rule" "runner_all" {
  count             = var.enable_runner ? 1 : 0
  security_group_id = aws_security_group.runner[0].id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# The upstream-proxy check (docs/lld/upstream-proxy.md) runs a test proxy here: a separate
# machine with its own public address, which the egress gateway's block list allows and which
# is clearly not the host's. Only the host's Elastic IP may reach it, on that one port.
resource "aws_vpc_security_group_ingress_rule" "runner_proxy" {
  count             = var.enable_runner && var.runner_proxy_port > 0 ? 1 : 0
  security_group_id = aws_security_group.runner[0].id
  ip_protocol       = "tcp"
  from_port         = var.runner_proxy_port
  to_port           = var.runner_proxy_port
  cidr_ipv4         = "${data.aws_eip.host.public_ip}/32"
}

resource "aws_instance" "runner" {
  count                       = var.enable_runner ? 1 : 0
  ami                         = data.aws_ssm_parameter.al2023.value
  instance_type               = var.runner_instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.runner[0].id]
  iam_instance_profile        = aws_iam_instance_profile.host.name
  associate_public_ip_address = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted   = true
  }

  # Node 22 and git for the harnesses; nothing else. Playwright only connects over CDP here.
  user_data = <<-EOT
    #!/bin/bash
    set -euxo pipefail
    dnf install -y nodejs22 nodejs22-npm git tar
    alternatives --install /usr/bin/node node /usr/bin/node-22 100 || true
    alternatives --install /usr/bin/npm npm /usr/bin/npm-22 100 || true
    alternatives --install /usr/bin/npx npx /usr/bin/npx-22 100 || true
    mkdir -p /srv/kestrel /var/log/kestrel-run /run/kestrel
    chown ec2-user:ec2-user /srv/kestrel /var/log/kestrel-run
    # An idle runner stops itself after 4 hours, in case a session forgets it (cost).
    echo "shutdown -h +240" | at now 2>/dev/null || shutdown -h +240
  EOT

  tags = { Name = "kestrel-runner" }
}
