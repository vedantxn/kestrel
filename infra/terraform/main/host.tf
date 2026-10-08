# The Elastic IP lives in the bootstrap stack so the hostname survives rebuilds (I5).
data "aws_eip" "host" {
  filter {
    name   = "tag:Name"
    values = ["kestrel"]
  }
  filter {
    name   = "tag:Project"
    values = ["kestrel"]
  }
}

# I9: Amazon Linux 2023. The image is chosen at first apply and then held (see ignore_changes),
# so a new AMI release never silently replaces the host.
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  hostname = "${replace(data.aws_eip.host.public_ip, ".", "-")}.sslip.io"
}

# I10: a separate data volume for Docker's data and Kestrel's state, formatted xfs with project
# quotas so the recording plan can limit per-session directories without re-provisioning.
resource "aws_ebs_volume" "data" {
  availability_zone = var.availability_zone
  size              = var.data_volume_gb
  type              = "gp3"
  encrypted         = true # threat model G-14
  tags              = { Name = "kestrel-data" }
}

resource "aws_instance" "host" {
  ami                         = data.aws_ssm_parameter.al2023.value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.host.id]
  iam_instance_profile        = aws_iam_instance_profile.host.name
  associate_public_ip_address = true

  # KVM inside the instance, for the microVM runtime (experiment V7, HLD 16 item 5). AWS offers
  # nested virtualisation on the M7i, C7i and M8i families since 2026.
  dynamic "cpu_options" {
    for_each = var.nested_virtualization ? [1] : []
    content {
      nested_virtualization = "enabled"
    }
  }

  # I11: tokens required, hop limit 1. A container on a bridge is one hop further away and
  # cannot obtain instance credentials.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    volume_size = var.root_volume_gb
    volume_type = "gp3"
    encrypted   = true # threat model G-14
    tags        = { Name = "kestrel-root" }
  }

  user_data = templatefile("${path.module}/userdata.sh.tpl", {
    data_volume_id = replace(aws_ebs_volume.data.id, "-", "")
    host_check     = file("${path.module}/../../host/host-check.sh")
    prepare_host   = file("${path.module}/../../host/prepare-host.sh")
  })

  tags = { Name = "kestrel-host" }

  lifecycle {
    # Hold the image and first-boot script: changing either would replace a working host.
    # To rebuild on purpose: `bin/tf main apply -replace=aws_instance.host`.
    ignore_changes = [ami, user_data]
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.host.id
}

resource "aws_eip_association" "host" {
  instance_id   = aws_instance.host.id
  allocation_id = data.aws_eip.host.id
}
